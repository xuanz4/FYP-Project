const database = require('../src/database');

async function findLatestIdByTransactionId(transactionId) {
  const [rows] = await database.query(
    'SELECT case_id FROM cases WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1',
    [transactionId],
  );
  return rows[0]?.case_id || null;
}

async function findWithAssigneeById(caseId) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.assigned_to, c.assigned_role, c.status, c.due_at,
            u.user_name AS assigned_user_name
     FROM cases c
     LEFT JOIN users u ON u.user_id = c.assigned_to
     WHERE c.case_id = ?
     LIMIT 1`,
    [caseId],
  );
  return rows[0] || null;
}

// Detail-page view: full case + assignment + STR report, joined out to every user reference
// so the view never has to re-look-up a name.
async function findDetailByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.status, c.notes,
            c.assigned_role, c.escalation_destination, c.referred_to_stro_at, c.referred_to_stro_by,
            c.last_actioned_by, c.last_actioned_at,
            c.due_at, c.created_at, c.updated_at, u.user_name AS assigned_user_name,
            c.decision, c.resolution_reason, c.analyst_notes, c.resolved_at, c.resolved_by,
            resolver.user_name AS resolved_by_name,
            sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
            sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
            sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by,
            sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason, sr.updated_at AS str_updated_at,
            prepared.user_name AS prepared_by_name,
            filed.user_name AS filed_by_name, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role,
            lastActor.user_name AS last_actioned_by_name
     FROM cases c
     LEFT JOIN users u ON u.user_id = c.assigned_to
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
     LEFT JOIN users filed ON filed.user_id = sr.filed_by
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN users resolver ON resolver.user_id = c.resolved_by
     LEFT JOIN users lastActor ON lastActor.user_id = c.last_actioned_by
     WHERE c.transaction_id = ?
     ORDER BY c.created_at DESC`,
    [transactionId],
  );
  return rows;
}

// Role-routing snapshot used by referToStro/escalate/fileStr/strNotRequired - transaction +
// case + STR report collapsed to one row for whichever case is currently open on it.
async function findRoleContextByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT t.*, m.merchant_name,
            c.case_id, c.assigned_to, c.assigned_role, c.escalation_destination, c.status AS case_status,
            c.due_at, c.referred_to_stro_at, c.referred_to_stro_by,
            sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
            sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
            sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by,
            sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function claimForAnalyst({ caseId, userId, dueAtSql }) {
  const [result] = await database.execute(
    `UPDATE cases
     SET assigned_to = ?, status = 'Under Review', due_at = ?,
         last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ? AND assigned_to IS NULL`,
    [userId, dueAtSql, userId, caseId],
  );
  return result.affectedRows > 0;
}

async function findStale(staleMinutes) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     WHERE c.assigned_to IS NULL
       AND c.assigned_role IS NULL
       AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')
       AND (t.risk_level IN ('Critical', 'High') OR (c.due_at IS NOT NULL AND c.due_at < NOW()))
       AND c.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [staleMinutes],
  );
  return rows;
}

async function autoAssign({ caseId, analystId, dueAtSql }) {
  const [result] = await database.execute(
    `UPDATE cases
     SET assigned_to = ?, status = 'Under Review', due_at = COALESCE(due_at, ?), updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ? AND assigned_to IS NULL`,
    [analystId, dueAtSql, caseId],
  );
  return result.affectedRows > 0;
}

async function findWithoutDueDate() {
  const [rows] = await database.query(
    `SELECT case_id, created_at FROM cases
     WHERE due_at IS NULL
       AND status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')`,
  );
  return rows;
}

async function setDueDateIfMissing(caseId, dueAt) {
  await database.execute(
    'UPDATE cases SET due_at = ? WHERE case_id = ? AND due_at IS NULL',
    [dueAt, caseId],
  );
}

// Shared by referToStro (Senior Analyst hands off directly) and escalate's STRO branch
// (Analyst refers directly) - identical routing, escalate additionally folds in escalation
// notes. Passing notes = null leaves the existing notes column untouched (COALESCE no-op).
async function routeToStro({ caseId, userId, notes = null, at }) {
  await database.execute(
    `UPDATE cases
     SET status = 'Escalated',
         assigned_role = 'STRO',
         escalation_destination = 'STRO',
         assigned_to = NULL,
         referred_to_stro_at = ?,
         referred_to_stro_by = ?,
         notes = COALESCE(?, notes),
         last_actioned_by = ?,
         last_actioned_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [at, userId, notes, userId, at, caseId],
  );
}

async function routeToSeniorAnalyst({ caseId, userId, notes }) {
  await database.execute(
    `UPDATE cases
     SET status = 'Pending Senior Review',
         assigned_role = 'Senior Analyst',
         escalation_destination = 'Senior Analyst',
         assigned_to = NULL,
         notes = COALESCE(?, notes),
         last_actioned_by = ?,
         last_actioned_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [notes, userId, caseId],
  );
}

async function markStrFiled({ caseId, resolvedAt, resolvedBy }) {
  await database.execute(
    `UPDATE cases
     SET status = 'STR Filed', decision = 'Escalated', resolution_reason = 'STR Filed',
         resolved_at = ?, resolved_by = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [resolvedAt, resolvedBy, resolvedBy, caseId],
  );
}

async function markStrNotRequired({ caseId, resolvedAt, resolvedBy }) {
  await database.execute(
    `UPDATE cases
     SET status = 'Resolved', decision = 'No STR Required',
         resolution_reason = 'STR not required after STRO review',
         resolved_at = ?, resolved_by = ?, last_actioned_by = ?,
         last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [resolvedAt, resolvedBy, resolvedBy, caseId],
  );
}

async function touchLastActioned({ caseId, userId }) {
  await database.execute(
    'UPDATE cases SET last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?',
    [userId, caseId],
  );
}

// Accepts an optional db client so rfiWorkflow.js's database.withTransaction block can pass its
// transaction executor instead of the plain singleton.
async function setStatusAndTouch({ caseId, status, userId }, db = database) {
  await db.execute(
    'UPDATE cases SET status = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?',
    [status, userId, caseId],
  );
}

async function countWithTransactionJoin(whereSql, values) {
  const [rows] = await database.query(
    `SELECT COUNT(*) AS total FROM cases c JOIN transactions t ON t.transaction_id = c.transaction_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id ${whereSql}`,
    values,
  );
  return Number(rows[0]?.total || 0);
}

async function listForAnalystCasesView(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
            c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
            u.user_name AS assigned_user_name, t.amount, t.risk_score, t.risk_level,
            t.status AS transaction_status, t.action_status, m.merchant_name, m.mcc_code,
            COUNT(DISTINCT tmr.rule_id) AS rules_count, sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users u ON u.user_id = c.assigned_to
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     GROUP BY c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
              c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
              u.user_name, t.amount, t.risk_score, t.risk_level, t.status, t.action_status,
              m.merchant_name, m.mcc_code, sr.str_status
     ORDER BY c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') ASC,
              (c.due_at IS NOT NULL AND c.due_at < NOW()) DESC,
              c.status = 'Pending RFI' DESC,
              c.status = 'Escalated' DESC,
              t.risk_level = 'Critical' DESC,
              t.risk_level = 'High' DESC,
              c.created_at ASC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function casesSummary(userId) {
  const [rows] = await database.query(
    `SELECT
       SUM(c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(c.escalation_destination = 'Senior Analyst') AS senior,
       SUM(c.escalation_destination = 'STRO') AS stro,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue
     FROM cases c`,
    [userId],
  );
  return rows[0] || {};
}

async function resolveCase({
  caseId, status, decision, resolutionReason, analystNotes, resolvedAt, resolvedBy,
  manualMccContribution, manualProfileContribution, manualDetectionContribution, manualFinalScore,
  discrepancyFlag, discrepancyNotes,
}) {
  await database.execute(
    `UPDATE cases
     SET status = ?, decision = ?, resolution_reason = ?, analyst_notes = ?, resolved_at = ?, resolved_by = ?,
         manual_mcc_contribution = ?, manual_profile_contribution = ?, manual_detection_contribution = ?, manual_final_score = ?,
         discrepancy_flag = ?, discrepancy_notes = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [
      status, decision, resolutionReason, analystNotes, resolvedAt, resolvedBy,
      manualMccContribution, manualProfileContribution, manualDetectionContribution, manualFinalScore,
      discrepancyFlag ? 1 : 0, discrepancyNotes, resolvedBy, caseId,
    ],
  );
}

async function findWithTransactionRiskLevel(caseId) {
  const [rows] = await database.query(
    `SELECT c.transaction_id, t.risk_level
     FROM cases c
     JOIN transactions t ON c.transaction_id = t.transaction_id
     WHERE c.case_id = ?
     LIMIT 1`,
    [caseId],
  );
  return rows[0] || null;
}

async function applyAnalystCaseAction({
  caseId, status, assignedRole, destination, userId, notes,
}) {
  await database.execute(
    `UPDATE cases SET status = ?, assigned_role = COALESCE(?, assigned_role),
     escalation_destination = COALESCE(?, escalation_destination),
     referred_to_stro_at = CASE WHEN ? = "STRO" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END,
     referred_to_stro_by = CASE WHEN ? = "STRO" THEN ? ELSE referred_to_stro_by END,
     notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?`,
    [status, assignedRole || null, destination || null, destination || null, destination || null, userId, notes || null, caseId],
  );
}

async function findTransactionId(caseId) {
  const [rows] = await database.query('SELECT transaction_id FROM cases WHERE case_id = ? LIMIT 1', [caseId]);
  return rows[0]?.transaction_id || null;
}

async function countForSeniorView(whereSql, values) {
  const [rows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     ${whereSql}`,
    values,
  );
  return Number(rows[0]?.total || 0);
}

async function listForSeniorCasesView(whereSql, values, orderSql, limit, offset) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
            c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
            assigned.user_name AS assigned_user_name, creator.user_name AS created_by_name,
            creator.user_role AS created_by_role, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role,
            lastActor.user_name AS last_actioned_by_name,
            t.amount, t.risk_score, t.risk_level, t.status AS transaction_status, t.action_status,
            m.merchant_name, m.mcc_code, COUNT(DISTINCT tmr.rule_id) AS rules_count,
            sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users assigned ON assigned.user_id = c.assigned_to
     LEFT JOIN users creator ON creator.user_id = c.created_by
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN users lastActor ON lastActor.user_id = c.last_actioned_by
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     GROUP BY c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
              c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
              assigned.user_name, creator.user_name, creator.user_role, referred.user_name,
              referred.user_role, lastActor.user_name, t.amount, t.risk_score, t.risk_level, t.status, t.action_status,
              m.merchant_name, m.mcc_code, sr.str_status
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function seniorCasesSummary(whereSql, userId) {
  const [rows] = await database.query(
    `SELECT
       SUM(c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS pending_review,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.assigned_to IS NULL) AS unassigned,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(c.escalation_destination = 'STRO') AS referred_to_stro,
       SUM(c.status IN ('Pending Senior Review', 'Under Review', 'Escalated') AND (c.escalation_destination IS NULL OR c.escalation_destination <> 'STRO')) AS ready_for_stro,
       SUM(t.risk_level = 'Critical' AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS critical_cases,
       SUM(c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') AND YEARWEEK(c.updated_at, 1) = YEARWEEK(CURDATE(), 1)) AS resolved_this_week,
       SUM(c.status IN ('Open', 'Under Review') AND (c.escalation_destination IS NULL OR c.escalation_destination <> 'STRO')) AS status_under_review,
       SUM(c.status = 'Pending RFI') AS status_pending_rfi,
       SUM(c.escalation_destination = 'STRO' AND c.status <> 'Pending RFI' AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS status_escalated,
       SUM(c.status = 'Pending Senior Review' AND (c.escalation_destination IS NULL OR c.escalation_destination <> 'STRO')) AS status_pending_senior,
       SUM(c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS status_resolved,
       COUNT(DISTINCT c.case_id) AS status_total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE ${whereSql}`,
    [userId],
  );
  return rows[0] || {};
}

async function applySeniorCaseAction({
  caseId, status, userId, notes,
}) {
  await database.execute(
    `UPDATE cases SET status = ?, assigned_role = CASE WHEN ? = "Escalated" THEN "STRO" ELSE assigned_role END,
     escalation_destination = CASE WHEN ? = "Escalated" THEN "STRO" ELSE escalation_destination END,
     referred_to_stro_at = CASE WHEN ? = "Escalated" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END,
     referred_to_stro_by = CASE WHEN ? = "Escalated" THEN ? ELSE referred_to_stro_by END,
     notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?`,
    [status, status, status, status, status, userId, notes || null, caseId],
  );
}

async function countForStroView(whereSql, values) {
  const [rows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}`,
    values,
  );
  return Number(rows[0]?.total || 0);
}

async function listForStroCasesView(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.assigned_to, c.assigned_role, c.status,
            c.escalation_destination, c.due_at, c.created_at, c.updated_at,
            assigned.user_name AS assigned_user_name, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role, lastActor.user_name AS last_actioned_by_name,
            t.amount, t.risk_score, t.risk_level,
            m.merchant_name, m.mcc_code, sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users assigned ON assigned.user_id = c.assigned_to
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN users lastActor ON lastActor.user_id = c.last_actioned_by
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     ORDER BY c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') ASC,
              (c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) DESC,
              c.status = 'Pending RFI' DESC,
              sr.str_status = 'Recommended' DESC,
              c.created_at ASC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function stroCasesSummary(whereSql) {
  const [rows] = await database.query(
    `SELECT
       SUM(sr.str_status = 'Recommended') AS recommended,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(sr.str_status = 'Filed') AS filed,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       COUNT(DISTINCT c.case_id) AS referred
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE ${whereSql}`,
  );
  return rows[0] || {};
}

async function updateStatusAndNotes({ caseId, status, notes }) {
  await database.execute(
    'UPDATE cases SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?',
    [status, notes || null, caseId],
  );
}

// Accepts an optional db client so rfiMailboxService.js's injected client/test fake shares this seam.
async function findAssignedTo(db, caseId) {
  const client = db || database;
  const [rows] = await client.query('SELECT assigned_to FROM cases WHERE case_id = ? LIMIT 1', [caseId]);
  return rows[0]?.assigned_to || null;
}

module.exports = {
  findAssignedTo,
  resolveCase,
  findLatestIdByTransactionId,
  findWithAssigneeById,
  findDetailByTransactionId,
  findRoleContextByTransactionId,
  claimForAnalyst,
  findStale,
  autoAssign,
  findWithoutDueDate,
  setDueDateIfMissing,
  routeToStro,
  routeToSeniorAnalyst,
  markStrFiled,
  markStrNotRequired,
  touchLastActioned,
  setStatusAndTouch,
  countForStroView,
  listForStroCasesView,
  stroCasesSummary,
  updateStatusAndNotes,
  countWithTransactionJoin,
  listForAnalystCasesView,
  casesSummary,
  findWithTransactionRiskLevel,
  applyAnalystCaseAction,
  findTransactionId,
  countForSeniorView,
  listForSeniorCasesView,
  seniorCasesSummary,
  applySeniorCaseAction,
};
