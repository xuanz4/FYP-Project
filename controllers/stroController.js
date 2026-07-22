const database = require('../src/database');
const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureAnalystListSchema, getAnalystFilterOptions, seniorFiltersFromQuery } = require('../src/lib/caseFilters');
const { stroAuditDefaultActions } = require('../src/constants');

function stroFiltersFromQuery(query) {
  return {
    ...seniorFiltersFromQuery(query),
    strStatus: String(query.strStatus || '').trim(),
    referredBy: String(query.referredBy || '').trim(),
    preparedBy: String(query.preparedBy || '').trim(),
    filingDate: String(query.filingDate || '').trim(),
  };
}

function stroCaseWhereAndValues(filters = {}) {
  const where = ["(c.escalation_destination = 'STRO' OR c.assigned_role = 'STRO' OR sr.str_status IS NOT NULL)"];
  const values = [];
  appendWhere(where, values, 'sr.str_status = ?', filters.strStatus);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.referred_to_stro_by = ?', filters.referredBy);
  if (filters.assignmentStatus === 'assigned') where.push('c.assigned_to IS NOT NULL');
  if (filters.assignmentStatus === 'unassigned') where.push('c.assigned_to IS NULL');
  if (filters.dueStatus === 'overdue') where.push("c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')");
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(c.case_id LIKE ? OR c.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  return { where, values };
}

async function loadStroCases(req) {
  await ensureAnalystListSchema();
  const filters = stroFiltersFromQuery(req.query);
  const { where, values } = stroCaseWhereAndValues(filters);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
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
    [...values, pagination.limit, pagination.offset],
  );
  const baseWhere = stroCaseWhereAndValues({}).where.join(' AND ');
  const [summaryRows] = await database.query(
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
     WHERE ${baseWhere}`,
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadStroReports(req) {
  await ensureAnalystListSchema();
  const filters = stroFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'sr.str_status = ?', filters.strStatus);
  appendWhere(where, values, 'sr.prepared_by = ?', filters.preparedBy);
  appendWhere(where, values, 'sr.filing_date = ?', filters.filingDate);
  if (filters.q) {
    where.push('(sr.reference_number LIKE ? OR sr.case_id LIKE ? OR sr.transaction_id LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM str_reports sr ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT sr.str_id, sr.reference_number, sr.case_id, sr.transaction_id, sr.str_status,
            sr.prepared_by, sr.filed_by, sr.filing_date, sr.created_at, sr.updated_at,
            prepared.user_name AS prepared_by_name
     FROM str_reports sr
     LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
     ${whereSql}
     ORDER BY sr.str_status = 'Filed' ASC, COALESCE(sr.updated_at, sr.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadStroAudit(req) {
  const filters = stroFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.scope !== 'all' && !filters.q) {
    where.push(`al.action IN (${stroAuditDefaultActions.map(() => '?').join(', ')})`);
    values.push(...stroAuditDefaultActions);
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
  const [caseData, reportData, auditData] = await Promise.all([
    loadStroCases(previewReq),
    loadStroReports(previewReq),
    loadStroAudit(previewReq),
  ]);
  return res.render('stro-dashboard', {
    title: 'STRO Overview',
    activePage: 'stro',
    currentUser: req.session.user,
    summary: {
      referred: Number(caseData.summary.referred || 0),
      recommended: Number(caseData.summary.recommended || 0),
      filed: Number(caseData.summary.filed || 0),
      waiting: Number(caseData.summary.waiting || 0),
      overdue: Number(caseData.summary.overdue || 0),
      totalReports: Number(reportData.pagination.total || 0),
    },
    casePreview: caseData.rows.slice(0, 5),
    reportPreview: reportData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
}

async function casesPage(req, res) {
  const data = await loadStroCases(req);
  return res.render('stro-cases', {
    title: 'STRO Cases',
    activePage: 'stro-cases',
    currentUser: req.session.user,
    ...data,
  });
}

async function strReportsPage(req, res) {
  const data = await loadStroReports(req);
  return res.render('stro-str-reports', {
    title: 'STR Reports',
    activePage: 'stro-str-reports',
    currentUser: req.session.user,
    ...data,
  });
}

async function auditLogPage(req, res) {
  const data = await loadStroAudit(req);
  return res.render('stro-audit-log', {
    title: 'STRO Audit Log',
    activePage: 'stro-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
}

async function caseAction(req, res) {
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query('SELECT transaction_id FROM cases WHERE case_id = ? LIMIT 1', [req.params.id]);
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/stro/cases');

  const actionMap = {
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
    str: { status: 'STR Filed', actionStatus: 'STR Filed', label: 'STR Filed' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/stro/cases');

  await database.execute('UPDATE cases SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/stro/cases');
}

module.exports = {
  dashboard,
  casesPage,
  strReportsPage,
  auditLogPage,
  caseAction,
};
