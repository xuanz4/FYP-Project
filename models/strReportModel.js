const database = require('../src/database');

// Shared by referToStro and escalate's direct-to-STRO path - both create the initial
// "Recommended" STR the STRO will later file or dismiss.
async function insertRecommended({
  strId, transactionId, caseId, referralReason, referralSummary, supportingEvidence, seniorAnalystNotes,
}) {
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())`,
    [strId, transactionId, caseId, referralReason, referralSummary, JSON.stringify(supportingEvidence), seniorAnalystNotes],
  );
}

async function updateFiling({
  caseId, strStatus, referenceNumber, reportingReason, suspicionSummary, transactionSummary,
  supportingEvidence, stroNotes, preparedBy, filedBy, filingDate, filedAt,
}) {
  await database.execute(
    `UPDATE str_reports
     SET str_status = ?, reference_number = ?, reporting_reason = ?, suspicion_summary = ?,
         transaction_summary = ?, supporting_evidence = ?, stro_notes = ?, prepared_by = ?,
         filed_by = ?, filing_date = ?, filed_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [
      strStatus,
      referenceNumber,
      reportingReason,
      suspicionSummary,
      transactionSummary,
      JSON.stringify(supportingEvidence),
      stroNotes,
      preparedBy,
      filedBy,
      filingDate,
      filedAt,
      caseId,
    ],
  );
}

async function markNotRequired(caseId, reason) {
  await database.execute(
    `UPDATE str_reports
     SET str_status = 'Not Required', not_required_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [reason, caseId],
  );
}

// analystController's dismiss/escalate quick-action - idempotent (no-op if a report already
// exists for the case) since it can fire from a generic case action rather than a dedicated form.
async function insertRecommendedIfAbsent({
  strId, transactionId, caseId, referralReason, referralSummary, supportingEvidence, seniorAnalystNotes,
}) {
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE str_status = str_status`,
    [strId, transactionId, caseId, referralReason, referralSummary, JSON.stringify(supportingEvidence), seniorAnalystNotes],
  );
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(`SELECT COUNT(*) AS total FROM str_reports sr ${whereSql}`, values);
  return Number(rows[0]?.total || 0);
}

async function listFiltered(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT sr.str_id, sr.reference_number, sr.case_id, sr.transaction_id, sr.str_status,
            sr.prepared_by, sr.filed_by, sr.filing_date, sr.created_at, sr.updated_at,
            prepared.user_name AS prepared_by_name
     FROM str_reports sr
     LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
     ${whereSql}
     ORDER BY sr.str_status = 'Filed' ASC, COALESCE(sr.updated_at, sr.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

module.exports = {
  insertRecommended, updateFiling, markNotRequired, insertRecommendedIfAbsent, countFiltered, listFiltered,
};
