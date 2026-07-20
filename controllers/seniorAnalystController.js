const database = require('../src/database');
const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureStrWorkflowSchema } = require('../src/lib/schema');
const { ensureAnalystListSchema, getAnalystFilterOptions, seniorFiltersFromQuery } = require('../src/lib/caseFilters');
const { seniorAuditDefaultActions } = require('../src/constants');

function seniorCaseWhereAndValues(filters = {}) {
  const where = [
    "(c.escalation_destination = 'Senior Analyst' OR c.assigned_role = 'Senior Analyst' OR c.status = 'Pending Senior Review' OR t.risk_level = 'Critical' OR c.escalation_destination = 'STRO')",
  ];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 'c.assigned_to = ?', filters.assignedTo);
  appendWhere(where, values, 'c.decision = ?', filters.decision);
  if (filters.assignmentStatus === 'assigned') where.push('c.assigned_to IS NOT NULL');
  if (filters.assignmentStatus === 'unassigned') where.push('c.assigned_to IS NULL');
  if (filters.dueStatus === 'overdue') where.push("c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')");
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.referralStatus === 'stro') where.push("c.escalation_destination = 'STRO'");
  if (filters.referralStatus === 'notReferred') where.push("(c.escalation_destination IS NULL OR c.escalation_destination <> 'STRO')");
  if (filters.q) {
    where.push('(c.case_id LIKE ? OR c.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  return { where, values };
}

function seniorCaseOrder(sort) {
  const sortMap = {
    created: 'c.created_at DESC',
    due: 'c.due_at IS NULL ASC, c.due_at ASC',
    score: 't.risk_score DESC',
    rules: 'rules_count DESC',
  };
  return sortMap[sort] || `c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') ASC,
    (c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) DESC,
    (c.assigned_to IS NULL AND t.risk_level = 'Critical') DESC,
    c.status = 'Pending RFI' DESC,
    t.risk_level = 'Critical' DESC,
    c.created_at ASC`;
}

async function loadSeniorCases(req) {
  await ensureAnalystListSchema();
  const filters = seniorFiltersFromQuery(req.query);
  const { where, values } = seniorCaseWhereAndValues(filters);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
            c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
            assigned.user_name AS assigned_user_name, creator.user_name AS created_by_name,
            creator.user_role AS created_by_role, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role,
            t.amount, t.risk_score, t.risk_level, t.status AS transaction_status, t.action_status,
            m.merchant_name, m.mcc_code, COUNT(DISTINCT tmr.rule_id) AS rules_count,
            sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users assigned ON assigned.user_id = c.assigned_to
     LEFT JOIN users creator ON creator.user_id = c.created_by
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     GROUP BY c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
              c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
              assigned.user_name, creator.user_name, creator.user_role, referred.user_name,
              referred.user_role, t.amount, t.risk_score, t.risk_level, t.status, t.action_status,
              m.merchant_name, m.mcc_code, sr.str_status
     ORDER BY ${seniorCaseOrder(filters.sort)}
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const baseWhere = seniorCaseWhereAndValues({}).where.join(' AND ');
  const [summaryRows] = await database.query(
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
     WHERE ${baseWhere}`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadSeniorAudit(req) {
  const filters = seniorFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.scope !== 'all' && !filters.q) {
    where.push(`al.action IN (${seniorAuditDefaultActions.map(() => '?').join(', ')})`);
    values.push(...seniorAuditDefaultActions);
  }
  appendWhere(where, values, 'al.action = ?', filters.actionType);
  appendWhere(where, values, 'al.user_id = ?', filters.userId);
  appendWhere(where, values, 'u.user_role = ?', filters.userRole);
  if (filters.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(filters.dateTo); }
  if (filters.q) {
    where.push(`(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?
      OR EXISTS (SELECT 1 FROM str_reports sr WHERE sr.transaction_id = al.transaction_id AND sr.reference_number LIKE ?))`);
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  return { rows, actions, users, filters, pagination };
}

async function dashboard(req, res) {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [caseData, auditData] = await Promise.all([
    loadSeniorCases(previewReq),
    loadSeniorAudit(previewReq),
  ]);

  return res.render('senior-analyst-dashboard', {
    title: 'Senior Analyst Overview',
    activePage: 'senior-analyst',
    currentUser: req.session.user,
    summary: {
      pendingReview: Number(caseData.summary.pending_review || 0),
      assignedToMe: Number(caseData.summary.assigned_to_me || 0),
      overdue: Number(caseData.summary.overdue || 0),
      waiting: Number(caseData.summary.waiting || 0),
      referredToStro: Number(caseData.summary.referred_to_stro || 0),
      criticalCases: Number(caseData.summary.critical_cases || 0),
      resolvedThisWeek: Number(caseData.summary.resolved_this_week || 0),
    },
    statusOverview: {
      underReview: Number(caseData.summary.status_under_review || 0),
      pendingRfi: Number(caseData.summary.status_pending_rfi || 0),
      escalated: Number(caseData.summary.status_escalated || 0),
      pendingSenior: Number(caseData.summary.status_pending_senior || 0),
      resolved: Number(caseData.summary.status_resolved || 0),
      total: Number(caseData.summary.status_total || 0),
    },
    casePreview: caseData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
}

async function casesPage(req, res) {
  const data = await loadSeniorCases(req);
  return res.render('senior-analyst-cases', {
    title: 'Cases Pending Senior Review',
    activePage: 'senior-analyst-cases',
    currentUser: req.session.user,
    ...data,
  });
}

async function auditLogPage(req, res) {
  const data = await loadSeniorAudit(req);
  return res.render('senior-analyst-audit-log', {
    title: 'Senior Analyst Audit Log',
    activePage: 'senior-analyst-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
}

async function caseAction(req, res) {
  await ensureStrWorkflowSchema();
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query('SELECT transaction_id FROM cases WHERE case_id = ? LIMIT 1', [req.params.id]);
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/senior-analyst/cases');

  const actionMap = {
    escalate: { status: 'Escalated', actionStatus: 'Escalated', label: 'Escalated to STRO' },
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/senior-analyst/cases');

  await database.execute('UPDATE cases SET status = ?, assigned_role = CASE WHEN ? = "Escalated" THEN "STRO" ELSE assigned_role END, escalation_destination = CASE WHEN ? = "Escalated" THEN "STRO" ELSE escalation_destination END, referred_to_stro_at = CASE WHEN ? = "Escalated" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END, referred_to_stro_by = CASE WHEN ? = "Escalated" THEN ? ELSE referred_to_stro_by END, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, selected.status, selected.status, selected.status, selected.status, req.session.user.id, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  if (selected.status === 'Escalated') {
    await database.execute(
      `INSERT INTO str_reports (
        str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
        supporting_evidence, senior_analyst_notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE str_status = str_status`,
      [id('STR'), caseRow.transaction_id, req.params.id, 'Possible suspicious activity', notes || selected.label, JSON.stringify(['Transaction behaviour']), notes || selected.label],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/senior-analyst/cases');
}

module.exports = {
  dashboard,
  casesPage,
  auditLogPage,
  caseAction,
};
