// Recomputes one merchant's risk profile snapshot right after a transaction is ingested for
// that merchant, so the *next* transaction's profileRiskContribution (see riskEngine.js) reads
// an up-to-date history without ever including the transaction that just triggered the update.
const { riskLevelFromScore } = require('../riskEngine');

const MIN_TRANSACTIONS_FOR_SCORING = 5;

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function computeProfileRiskScore({
  transactionCount, flaggedTransactionRate, escalationCount, confirmedSuspiciousCaseCount, ruleTriggerCount,
}) {
  const flagBand = Math.min(40, Math.round(flaggedTransactionRate * 40));
  const escalationBand = Math.min(20, escalationCount * 10);
  const strBand = Math.min(30, confirmedSuspiciousCaseCount * 15);
  const ruleDensityBand = transactionCount > 0
    ? Math.min(10, Math.round((ruleTriggerCount / transactionCount) * 10))
    : 0;
  return Math.min(100, flagBand + escalationBand + strBand + ruleDensityBand);
}

function buildProfileRiskReasons({
  flaggedTransactionRate, escalationCount, confirmedSuspiciousCaseCount, ruleTriggerCount, transactionCount,
}) {
  const reasons = [];
  reasons.push(`Flagged on ${Math.round(flaggedTransactionRate * 100)}% of ${transactionCount} transaction${transactionCount === 1 ? '' : 's'}`);
  if (escalationCount > 0) reasons.push(`${escalationCount} prior escalation${escalationCount === 1 ? '' : 's'}`);
  if (confirmedSuspiciousCaseCount > 0) reasons.push(`${confirmedSuspiciousCaseCount} confirmed STR filing${confirmedSuspiciousCaseCount === 1 ? '' : 's'}`);
  if (ruleTriggerCount > 0) reasons.push(`${ruleTriggerCount} monitoring-rule trigger${ruleTriggerCount === 1 ? '' : 's'} recorded`);
  return reasons;
}

// Reconstructs the profile component for historical imports in chronological order. Each
// transaction sees only the same merchant's earlier transactions, matching live ingestion and
// avoiding future activity leaking into an older transaction's score.
function buildHistoricalProfileRiskUpdates(rows) {
  const stateByMerchant = new Map();
  return rows.map((row) => {
    const state = stateByMerchant.get(row.merchant_id) || {
      transactionCount: 0,
      flaggedTransactionCount: 0,
      ruleTriggerCount: 0,
      escalationCount: 0,
      confirmedSuspiciousCaseCount: 0,
    };
    const profileRiskContribution = state.transactionCount >= MIN_TRANSACTIONS_FOR_SCORING
      ? computeProfileRiskScore({
        transactionCount: state.transactionCount,
        flaggedTransactionRate: state.flaggedTransactionCount / state.transactionCount,
        escalationCount: state.escalationCount,
        confirmedSuspiciousCaseCount: state.confirmedSuspiciousCaseCount,
        ruleTriggerCount: state.ruleTriggerCount,
      })
      : 0;
    const riskScore = Math.min(
      100,
      Number(row.mcc_risk_contribution || 0)
        + profileRiskContribution
        + Number(row.transaction_detection_contribution || 0),
    );
    const riskLevel = riskLevelFromScore(riskScore);
    const status = riskLevel === 'Low' ? 'Cleared' : 'Flagged';

    state.transactionCount += 1;
    if (status === 'Flagged') state.flaggedTransactionCount += 1;
    state.ruleTriggerCount += Number(row.rule_trigger_count || 0);
    state.escalationCount += Number(row.escalated || 0);
    state.confirmedSuspiciousCaseCount += Number(row.str_filed || 0);
    stateByMerchant.set(row.merchant_id, state);

    return {
      transactionId: row.transaction_id,
      profileRiskContribution,
      riskScore,
      riskLevel,
      status,
    };
  });
}

async function rebuildHistoricalProfileRisk(database) {
  const [rows] = await database.query(
    `SELECT t.transaction_id, t.merchant_id, t.txn_time,
            t.mcc_risk_contribution, t.transaction_detection_contribution,
            COUNT(DISTINCT tmr.id) AS rule_trigger_count,
            MAX(c.escalation_destination IS NOT NULL) AS escalated,
            MAX(sr.str_status = 'Filed') AS str_filed
     FROM transactions t
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.transaction_id = t.transaction_id
     GROUP BY t.transaction_id
     ORDER BY t.txn_time, t.transaction_id`,
  );
  const updates = buildHistoricalProfileRiskUpdates(rows);

  await database.withTransaction(async (transaction) => {
    for (const update of updates) {
      // The database's transactions_auto_case_update trigger opens a case when this repair
      // changes a previously-cleared transaction to Flagged.
      // eslint-disable-next-line no-await-in-loop
      await transaction.execute(
        `UPDATE transactions
         SET profile_risk_contribution = ?, risk_score = ?, risk_level = ?, status = ?
         WHERE transaction_id = ?`,
        [
          update.profileRiskContribution,
          update.riskScore,
          update.riskLevel,
          update.status,
          update.transactionId,
        ],
      );
    }
  });

  const [merchantRows] = await database.query(
    'SELECT merchant_id FROM merchants WHERE merchant_mid IS NOT NULL',
  );
  for (const merchant of merchantRows) {
    // eslint-disable-next-line no-await-in-loop
    await upsertMerchantRiskProfile(database, merchant.merchant_id);
  }

  return {
    updated: updates.length,
    positiveProfileContributions: updates.filter((row) => row.profileRiskContribution > 0).length,
  };
}

async function upsertMerchantRiskProfile(database, merchantId) {
  const [merchantRows] = await database.query(
    'SELECT merchant_id, merchant_name, merchant_mid FROM merchants WHERE merchant_id = ? LIMIT 1',
    [merchantId],
  );
  const merchant = merchantRows[0];
  // No merchant_mid on file (e.g. retired demo merchants) - no profile row; MCC + Detection
  // still compute normally, and the view shows "Merchant account identifier unavailable".
  if (!merchant || !merchant.merchant_mid) return;

  const [[totals]] = await database.query(
    `SELECT COUNT(*) AS transaction_count,
            SUM(CASE WHEN status = 'Flagged' THEN 1 ELSE 0 END) AS flagged_transaction_count,
            SUM(CASE WHEN payment_status = 'declined' THEN 1 ELSE 0 END) AS declined_transaction_count,
            COALESCE(SUM(amount), 0) AS total_transaction_amount,
            COALESCE(AVG(amount), 0) AS average_transaction_amount,
            COALESCE(MAX(amount), 0) AS maximum_transaction_amount,
            MIN(created_at) AS first_seen_at,
            MAX(created_at) AS last_seen_at
     FROM transactions
     WHERE merchant_id = ?`,
    [merchantId],
  );
  const [[ruleTotals]] = await database.query(
    `SELECT COUNT(*) AS rule_trigger_count
     FROM transaction_matched_rules tmr
     JOIN transactions t ON t.transaction_id = tmr.transaction_id
     WHERE t.merchant_id = ?`,
    [merchantId],
  );
  const [[escalationTotals]] = await database.query(
    `SELECT COUNT(*) AS escalation_count
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     WHERE t.merchant_id = ? AND c.escalation_destination IS NOT NULL`,
    [merchantId],
  );
  const [[strTotals]] = await database.query(
    `SELECT COUNT(*) AS confirmed_suspicious_case_count
     FROM str_reports sr
     JOIN transactions t ON t.transaction_id = sr.transaction_id
     WHERE t.merchant_id = ? AND sr.str_status = 'Filed'`,
    [merchantId],
  );

  const transactionCount = Number(totals.transaction_count) || 0;
  const flaggedTransactionCount = Number(totals.flagged_transaction_count) || 0;
  const flaggedTransactionRate = transactionCount > 0 ? flaggedTransactionCount / transactionCount : 0;
  const escalationCount = Number(escalationTotals.escalation_count) || 0;
  const confirmedSuspiciousCaseCount = Number(strTotals.confirmed_suspicious_case_count) || 0;
  const ruleTriggerCount = Number(ruleTotals.rule_trigger_count) || 0;

  const hasEnoughHistory = transactionCount >= MIN_TRANSACTIONS_FOR_SCORING;
  const profileRiskScore = hasEnoughHistory ? computeProfileRiskScore({
    transactionCount, flaggedTransactionRate, escalationCount, confirmedSuspiciousCaseCount, ruleTriggerCount,
  }) : 0;
  const profileRiskLevel = hasEnoughHistory ? riskLevelFromScore(profileRiskScore) : 'Insufficient History';
  const profileRiskReasons = hasEnoughHistory ? buildProfileRiskReasons({
    flaggedTransactionRate, escalationCount, confirmedSuspiciousCaseCount, ruleTriggerCount, transactionCount,
  }) : ['Fewer than 5 transactions on file'];

  await database.execute(
    `INSERT INTO merchant_risk_profiles (
      merchant_mid, merchant_id, merchant_name, transaction_count, flagged_transaction_count,
      flagged_transaction_rate, declined_transaction_count, total_transaction_amount,
      average_transaction_amount, maximum_transaction_amount, rule_trigger_count, escalation_count,
      confirmed_suspicious_case_count, profile_risk_score, profile_risk_level, profile_risk_reasons,
      first_seen_at, last_seen_at, risk_last_calculated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      merchant_id = VALUES(merchant_id),
      merchant_name = VALUES(merchant_name),
      transaction_count = VALUES(transaction_count),
      flagged_transaction_count = VALUES(flagged_transaction_count),
      flagged_transaction_rate = VALUES(flagged_transaction_rate),
      declined_transaction_count = VALUES(declined_transaction_count),
      total_transaction_amount = VALUES(total_transaction_amount),
      average_transaction_amount = VALUES(average_transaction_amount),
      maximum_transaction_amount = VALUES(maximum_transaction_amount),
      rule_trigger_count = VALUES(rule_trigger_count),
      escalation_count = VALUES(escalation_count),
      confirmed_suspicious_case_count = VALUES(confirmed_suspicious_case_count),
      profile_risk_score = VALUES(profile_risk_score),
      profile_risk_level = VALUES(profile_risk_level),
      profile_risk_reasons = VALUES(profile_risk_reasons),
      first_seen_at = VALUES(first_seen_at),
      last_seen_at = VALUES(last_seen_at),
      risk_last_calculated_at = NOW()`,
    [
      merchant.merchant_mid,
      merchant.merchant_id,
      merchant.merchant_name,
      transactionCount,
      flaggedTransactionCount,
      round2(flaggedTransactionRate),
      Number(totals.declined_transaction_count) || 0,
      round2(totals.total_transaction_amount),
      round2(totals.average_transaction_amount),
      round2(totals.maximum_transaction_amount),
      ruleTriggerCount,
      escalationCount,
      confirmedSuspiciousCaseCount,
      profileRiskScore,
      profileRiskLevel,
      JSON.stringify(profileRiskReasons),
      totals.first_seen_at,
      totals.last_seen_at,
    ],
  );
}

// TXN-<year>-<6-digit sequence>, content-free (no merchant/email data) and assigned exactly
// once - never regenerated or updated after insert. Sequential within each year, based on the
// highest existing reference for that year at insert time.
async function generateUniqueTransactionReference(database, txnTime) {
  const year = (txnTime instanceof Date ? txnTime : new Date(txnTime)).getFullYear();
  const prefix = `TXN-${year}-`;
  const [rows] = await database.query(
    `SELECT unique_transaction_reference
     FROM transactions
     WHERE unique_transaction_reference LIKE ?
     ORDER BY unique_transaction_reference DESC
     LIMIT 1`,
    [`${prefix}%`],
  );
  const last = rows[0]?.unique_transaction_reference;
  const lastSequence = last ? Number(last.slice(prefix.length)) || 0 : 0;
  const nextSequence = lastSequence + 1;
  return `${prefix}${String(nextSequence).padStart(6, '0')}`;
}

module.exports = {
  upsertMerchantRiskProfile,
  generateUniqueTransactionReference,
  computeProfileRiskScore,
  buildHistoricalProfileRiskUpdates,
  rebuildHistoricalProfileRisk,
  MIN_TRANSACTIONS_FOR_SCORING,
};
