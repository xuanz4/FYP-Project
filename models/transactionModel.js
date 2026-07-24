const database = require('../src/database');

// riskEngine.js always passes its own db explicitly (the real database, or a test's fake) - one
// query per incoming transaction, so it must go through the exact same query text either way.
async function findRecentHistoryForMerchant(db, merchantId, windowStart, txnTime) {
  const [rows] = await db.query(
    `SELECT store_id, amount, issuer_country, txn_time, card_ref
     FROM transactions
     WHERE merchant_id = ? AND txn_time >= ? AND txn_time < ?`,
    [merchantId, windowStart, txnTime],
  );
  return rows;
}

// transactionIngestion.js always passes its own db explicitly. Every field is already validated/
// defaulted by the caller (e.g. cardBin/cardLast4 format checks) - this just runs the insert.
async function insertIngested(db, {
  transactionId, uniqueTransactionReference, merchantId, storeId, amount, method, scheme, issuerCountry,
  issuerBank, cardBin, cardLast4, cvvValidationResult, expiryValidationResult, transactionCode,
  transactionType, entryMode, paymentStatus, paymentStatusLabel, paymentStatusTone, net, fee, txnTime,
  sourceNote, riskScore, riskLevel, mccRiskContribution, profileRiskContribution, transactionDetectionContribution,
  status, cardRef,
}) {
  await db.execute(
    `INSERT INTO transactions (
      transaction_id, unique_transaction_reference, merchant_id, store_id, amount, method, scheme, issuer_country,
      issuer_bank, card_bin, card_last4, cvv_validation_result, expiry_validation_result, transaction_code,
      transaction_type, entry_mode, payment_status, payment_status_label, payment_status_tone,
      net, fee, txn_time, source_note, risk_score, risk_level,
      mcc_risk_contribution, profile_risk_contribution, transaction_detection_contribution,
      status, action_status, created_at, card_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'None', ?, ?)`,
    [
      transactionId, uniqueTransactionReference, merchantId, storeId, amount, method, scheme, issuerCountry,
      issuerBank, cardBin, cardLast4, cvvValidationResult, expiryValidationResult, transactionCode,
      transactionType, entryMode, paymentStatus, paymentStatusLabel, paymentStatusTone,
      net, fee, txnTime, sourceNote,
      riskScore, riskLevel,
      mccRiskContribution, profileRiskContribution, transactionDetectionContribution,
      status, txnTime, cardRef,
    ],
  );
}

async function findMerchantByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT m.merchant_id, m.merchant_name
     FROM transactions t
     JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE t.transaction_id = ?
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function findDetailById(transactionId) {
  const [rows] = await database.query(
    `SELECT t.*, m.merchant_name, m.merchant_mid, m.mcc_risk_score,
            mc.contact_name, mc.rfi_email, mc.phone_number,
            mrp.profile_risk_score, mrp.profile_risk_level, mrp.transaction_count AS profile_transaction_count,
            mrp.flagged_transaction_rate, mrp.flagged_transaction_count AS profile_flagged_transaction_count,
            mrp.escalation_count AS profile_escalation_count,
            mrp.risk_last_calculated_at
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = t.merchant_id AND mc.status = 'Active'
     LEFT JOIN merchant_risk_profiles mrp ON mrp.merchant_mid = m.merchant_mid
     WHERE t.transaction_id = ?
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function findMerchantIdById(transactionId) {
  const [rows] = await database.query(
    'SELECT merchant_id FROM transactions WHERE transaction_id = ? LIMIT 1',
    [transactionId],
  );
  return rows[0]?.merchant_id || null;
}

// Latest case linked to the transaction, if any - used when a document upload needs to know
// which case it belongs to alongside the merchant.
async function findMerchantAndLatestCaseId(transactionId) {
  const [rows] = await database.query(
    `SELECT t.merchant_id, c.case_id
     FROM transactions t
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function updateActionStatus(transactionId, actionStatus, db = database) {
  await db.execute(
    'UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?',
    [actionStatus, transactionId],
  );
}

async function updateFinalRisk(transactionId, { finalRiskScore, finalRiskLevel }) {
  await database.execute(
    `UPDATE transactions
     SET action_status = 'STR Filed', final_risk_score = ?, final_risk_level = ?, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = ?`,
    [finalRiskScore, finalRiskLevel, transactionId],
  );
}

// Contact info is always queried live against merchant_contacts (never cached) so an Admin's
// edit in Merchant Management takes effect on the very next RFI with no other code change.
async function findRfiContextByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT t.transaction_id, t.unique_transaction_reference, t.amount, t.created_at, t.action_status,
            m.merchant_name, m.merchant_mid,
            mc.contact_name, mc.rfi_email,
            c.case_id, c.status AS case_status,
            c.assigned_role, c.escalation_destination, sr.str_status
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = t.merchant_id AND mc.status = 'Active'
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function findResolveContextByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT t.transaction_id, t.unique_transaction_reference, t.merchant_id, t.risk_score, t.risk_level, t.status, t.action_status,
            t.final_risk_score, t.final_risk_level,
            t.mcc_risk_contribution, t.profile_risk_contribution, t.transaction_detection_contribution,
            c.case_id, c.status AS case_status, c.resolved_at
     FROM transactions t
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function markResolved(transactionId, { finalRiskScore, finalRiskLevel, actionStatus }) {
  await database.execute(
    `UPDATE transactions
     SET final_risk_score = ?, final_risk_level = ?, action_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = ?`,
    [finalRiskScore, finalRiskLevel, actionStatus, transactionId],
  );
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`, values);
  return Number(rows[0]?.total || 0);
}

// Analyst live-feed and working-queue views share this transaction+case+rule shape - only the
// WHERE and ORDER BY differ between the two, both built by the caller.
async function listWithCaseSummary({
  selectSql, whereSql, groupBySql, orderSql, values, limit, offset,
}) {
  const [rows] = await database.query(
    `${selectSql}
     ${whereSql}
     ${groupBySql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function countForQueue(whereSql, values) {
  const [rows] = await database.query(
    `SELECT COUNT(DISTINCT t.transaction_id) AS total
     FROM transactions t
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     ${whereSql}`,
    values,
  );
  return Number(rows[0]?.total || 0);
}

async function queueSummary(whereConditionsSql, userId) {
  const [rows] = await database.query(
    `SELECT
       SUM(t.risk_level = 'Critical') AS critical,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       SUM(c.assigned_to IS NULL) AS unassigned,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting
     FROM transactions t
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     WHERE ${whereConditionsSql}`,
    [userId],
  );
  return rows[0] || {};
}

async function countCreatedSince(hours) {
  const [rows] = await database.query(
    'SELECT COUNT(*) AS total FROM transactions WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)',
    [hours],
  );
  return Number(rows[0]?.total || 0);
}

module.exports = {
  findRecentHistoryForMerchant,
  insertIngested,
  findMerchantByTransactionId,
  findDetailById,
  findMerchantIdById,
  findMerchantAndLatestCaseId,
  updateActionStatus,
  updateFinalRisk,
  findRfiContextByTransactionId,
  findResolveContextByTransactionId,
  markResolved,
  countFiltered,
  listWithCaseSummary,
  countForQueue,
  queueSummary,
  countCreatedSince,
};
