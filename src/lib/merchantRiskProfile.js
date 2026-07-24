// Recomputes one merchant's risk profile snapshot right after a transaction is ingested for
// that merchant, so the *next* transaction's profileRiskContribution (see riskEngine.js) reads
// an up-to-date history without ever including the transaction that just triggered the update.
const { riskLevelFromScore } = require('../riskEngine');
const merchantRiskProfileModel = require('../../models/merchantRiskProfileModel');

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
  const rows = await merchantRiskProfileModel.findHistoricalTransactionRows(database);
  const updates = buildHistoricalProfileRiskUpdates(rows);

  await database.withTransaction(async (transaction) => {
    for (const update of updates) {
      // The database's transactions_auto_case_update trigger opens a case when this repair
      // changes a previously-cleared transaction to Flagged.
      // eslint-disable-next-line no-await-in-loop
      await merchantRiskProfileModel.updateTransactionRiskFields(transaction, update);
    }
  });

  const merchantRows = await merchantRiskProfileModel.findMerchantIdsWithMid(database);
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
  const merchant = await merchantRiskProfileModel.findMerchantForProfile(database, merchantId);
  // No merchant_mid on file (e.g. retired demo merchants) - no profile row; MCC + Detection
  // still compute normally, and the view shows "Merchant account identifier unavailable".
  if (!merchant || !merchant.merchant_mid) return;

  const totals = await merchantRiskProfileModel.findTransactionTotals(database, merchantId);
  const ruleTotals = await merchantRiskProfileModel.findRuleTriggerTotal(database, merchantId);
  const escalationTotals = await merchantRiskProfileModel.findEscalationTotal(database, merchantId);
  const strTotals = await merchantRiskProfileModel.findStrTotal(database, merchantId);

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

  await merchantRiskProfileModel.upsertProfile(database, {
    merchantMid: merchant.merchant_mid,
    merchantId: merchant.merchant_id,
    merchantName: merchant.merchant_name,
    transactionCount,
    flaggedTransactionCount,
    flaggedTransactionRate: round2(flaggedTransactionRate),
    declinedTransactionCount: Number(totals.declined_transaction_count) || 0,
    totalTransactionAmount: round2(totals.total_transaction_amount),
    averageTransactionAmount: round2(totals.average_transaction_amount),
    maximumTransactionAmount: round2(totals.maximum_transaction_amount),
    ruleTriggerCount,
    escalationCount,
    confirmedSuspiciousCaseCount,
    profileRiskScore,
    profileRiskLevel,
    profileRiskReasons: JSON.stringify(profileRiskReasons),
    firstSeenAt: totals.first_seen_at,
    lastSeenAt: totals.last_seen_at,
  });
}

// TXN-<year>-<6-digit sequence>, content-free (no merchant/email data) and assigned exactly
// once - never regenerated or updated after insert. Sequential within each year, based on the
// highest existing reference for that year at insert time.
async function generateUniqueTransactionReference(database, txnTime) {
  const year = (txnTime instanceof Date ? txnTime : new Date(txnTime)).getFullYear();
  const prefix = `TXN-${year}-`;
  const last = await merchantRiskProfileModel.findLatestReferenceForYear(database, `${prefix}%`);
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
