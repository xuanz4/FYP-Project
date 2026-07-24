// This module always takes its db client as an explicit, mandatory first argument (no
// module-level `database` fallback) - callers are riskEngine/transactionIngestion.js's real
// database param, a historical-rebuild transaction executor, or a test's fake, and every one of
// them must go through the exact same query text.

async function findProfileContributionSnapshot(db, merchantMid) {
  const [rows] = await db.query(
    `SELECT profile_risk_score, transaction_count
     FROM merchant_risk_profiles
     WHERE merchant_mid = ?
     LIMIT 1`,
    [merchantMid],
  );
  return rows[0] || null;
}

async function findHistoricalTransactionRows(db) {
  const [rows] = await db.query(
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
  return rows;
}

async function updateTransactionRiskFields(db, {
  transactionId, profileRiskContribution, riskScore, riskLevel, status,
}) {
  await db.execute(
    `UPDATE transactions
     SET profile_risk_contribution = ?, risk_score = ?, risk_level = ?, status = ?
     WHERE transaction_id = ?`,
    [profileRiskContribution, riskScore, riskLevel, status, transactionId],
  );
}

async function findMerchantIdsWithMid(db) {
  const [rows] = await db.query('SELECT merchant_id FROM merchants WHERE merchant_mid IS NOT NULL');
  return rows;
}

async function findMerchantForProfile(db, merchantId) {
  const [rows] = await db.query(
    'SELECT merchant_id, merchant_name, merchant_mid FROM merchants WHERE merchant_id = ? LIMIT 1',
    [merchantId],
  );
  return rows[0] || null;
}

async function findTransactionTotals(db, merchantId) {
  const [[totals]] = await db.query(
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
  return totals;
}

async function findRuleTriggerTotal(db, merchantId) {
  const [[ruleTotals]] = await db.query(
    `SELECT COUNT(*) AS rule_trigger_count
     FROM transaction_matched_rules tmr
     JOIN transactions t ON t.transaction_id = tmr.transaction_id
     WHERE t.merchant_id = ?`,
    [merchantId],
  );
  return ruleTotals;
}

async function findEscalationTotal(db, merchantId) {
  const [[escalationTotals]] = await db.query(
    `SELECT COUNT(*) AS escalation_count
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     WHERE t.merchant_id = ? AND c.escalation_destination IS NOT NULL`,
    [merchantId],
  );
  return escalationTotals;
}

async function findStrTotal(db, merchantId) {
  const [[strTotals]] = await db.query(
    `SELECT COUNT(*) AS confirmed_suspicious_case_count
     FROM str_reports sr
     JOIN transactions t ON t.transaction_id = sr.transaction_id
     WHERE t.merchant_id = ? AND sr.str_status = 'Filed'`,
    [merchantId],
  );
  return strTotals;
}

async function upsertProfile(db, {
  merchantMid, merchantId, merchantName, transactionCount, flaggedTransactionCount, flaggedTransactionRate,
  declinedTransactionCount, totalTransactionAmount, averageTransactionAmount, maximumTransactionAmount,
  ruleTriggerCount, escalationCount, confirmedSuspiciousCaseCount, profileRiskScore, profileRiskLevel,
  profileRiskReasons, firstSeenAt, lastSeenAt,
}) {
  await db.execute(
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
      merchantMid,
      merchantId,
      merchantName,
      transactionCount,
      flaggedTransactionCount,
      flaggedTransactionRate,
      declinedTransactionCount,
      totalTransactionAmount,
      averageTransactionAmount,
      maximumTransactionAmount,
      ruleTriggerCount,
      escalationCount,
      confirmedSuspiciousCaseCount,
      profileRiskScore,
      profileRiskLevel,
      profileRiskReasons,
      firstSeenAt,
      lastSeenAt,
    ],
  );
}

async function findLatestReferenceForYear(db, likePattern) {
  const [rows] = await db.query(
    `SELECT unique_transaction_reference
     FROM transactions
     WHERE unique_transaction_reference LIKE ?
     ORDER BY unique_transaction_reference DESC
     LIMIT 1`,
    [likePattern],
  );
  return rows[0]?.unique_transaction_reference || null;
}

module.exports = {
  findProfileContributionSnapshot,
  findHistoricalTransactionRows,
  updateTransactionRiskFields,
  findMerchantIdsWithMid,
  findMerchantForProfile,
  findTransactionTotals,
  findRuleTriggerTotal,
  findEscalationTotal,
  findStrTotal,
  upsertProfile,
  findLatestReferenceForYear,
};
