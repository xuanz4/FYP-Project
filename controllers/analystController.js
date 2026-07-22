const database = require('../src/database');
const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureStrWorkflowSchema } = require('../src/lib/schema');
const { ensureAnalystListSchema, analystFiltersFromQuery, getAnalystFilterOptions } = require('../src/lib/caseFilters');

function analystTransactionBaseSelect() {
  return `SELECT t.transaction_id, t.merchant_id, t.amount, t.transaction_code,
                 t.scheme, t.issuer_country, t.entry_mode, t.txn_time,
                 t.risk_score, t.risk_level, t.status, t.action_status,
                 t.created_at, t.updated_at,
                 m.merchant_name, m.mcc_code,
                 COUNT(DISTINCT tmr.rule_id) AS rules_count,
                 c.case_id, c.status AS case_status, c.assigned_to, c.assigned_role,
                 c.escalation_destination, c.due_at, c.decision,
                 u.user_name AS assigned_user_name,
                 sr.str_status
          FROM transactions t
          LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
          LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
          LEFT JOIN cases c ON c.transaction_id = t.transaction_id
          LEFT JOIN users u ON u.user_id = c.assigned_to
          LEFT JOIN str_reports sr ON sr.case_id = c.case_id`;
}

function analystGroupBy() {
  return `GROUP BY t.transaction_id, t.merchant_id, t.amount, t.transaction_code,
                  t.scheme, t.issuer_country, t.entry_mode, t.txn_time,
                  t.risk_score, t.risk_level, t.status, t.action_status,
                  t.created_at, t.updated_at, m.merchant_name, m.mcc_code,
                  c.case_id, c.status, c.assigned_to, c.assigned_role,
                  c.escalation_destination, c.due_at, c.decision,
                  u.user_name, sr.str_status`;
}

async function loadAnalystTransactions(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 't.status = ?', filters.transactionStatus);
  appendWhere(where, values, 't.merchant_id = ?', filters.merchantId);
  if (filters.q) {
    where.push('(t.transaction_id LIKE ? OR t.transaction_code LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `${analystTransactionBaseSelect()}
     ${whereSql}
     ${analystGroupBy()}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

function queueWhereAndValues(filters) {
  const where = [
    "(t.status = 'Flagged' OR t.action_status <> 'None' OR c.case_id IS NOT NULL)",
    "NOT (t.status = 'Cleared' AND t.risk_level = 'Low' AND c.case_id IS NULL)",
    "(c.status IS NULL OR c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed'))",
  ];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 'c.assigned_to = ?', filters.assignedTo);
  appendWhere(where, values, 'c.decision = ?', filters.decision);
  if (filters.dueStatus === 'overdue') where.push('c.due_at IS NOT NULL AND c.due_at < NOW()');
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(t.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  return { where, values };
}

function queueOrder(sort) {
  const sortMap = {
    created: 't.created_at DESC',
    due: 'c.due_at IS NULL ASC, c.due_at ASC',
    score: 't.risk_score DESC',
    rules: 'rules_count DESC',
  };
  return sortMap[sort] || `(c.due_at IS NOT NULL AND c.due_at < NOW()) DESC,
    t.risk_level = 'Critical' DESC,
    c.status = 'Escalated' DESC,
    c.status = 'Pending RFI' DESC,
    t.risk_level = 'High' DESC,
    t.created_at ASC`;
}

async function loadAnalystQueue(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  const { where, values } = queueWhereAndValues(filters);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT t.transaction_id) AS total
     FROM transactions t
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `${analystTransactionBaseSelect()}
     ${whereSql}
     ${analystGroupBy()}
     ORDER BY ${queueOrder(filters.sort)}
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [summaryRows] = await database.query(
    `SELECT
       SUM(t.risk_level = 'Critical') AS critical,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       SUM(c.assigned_to IS NULL) AS unassigned,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting
     FROM transactions t
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     WHERE ${queueWhereAndValues({}).where.join(' AND ')}`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadAnalystCases(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 'c.assigned_role = ?', filters.assignedRole);
  appendWhere(where, values, 'c.assigned_to = ?', filters.assignedTo);
  appendWhere(where, values, 'c.escalation_destination = ?', filters.escalatedTo);
  appendWhere(where, values, 'c.decision = ?', filters.decision);
  if (filters.dueStatus === 'overdue') where.push("c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')");
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(c.case_id LIKE ? OR c.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM cases c JOIN transactions t ON t.transaction_id = c.transaction_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
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
    [...values, pagination.limit, pagination.offset],
  );
  const [summaryRows] = await database.query(
    `SELECT
       SUM(c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(c.escalation_destination = 'Senior Analyst') AS senior,
       SUM(c.escalation_destination = 'STRO') AS stro,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue
     FROM cases c`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadAnalystAudit(req) {
  const filters = analystFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'al.action = ?', String(req.query.actionType || '').trim());
  appendWhere(where, values, 'al.user_id = ?', String(req.query.userId || '').trim());
  appendWhere(where, values, 'u.user_role = ?', String(req.query.userRole || '').trim());
  if (req.query.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(req.query.dateFrom); }
  if (req.query.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(req.query.dateTo); }
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
  const [queueData, casesData, auditData, newTransactionsRows] = await Promise.all([
    loadAnalystQueue(previewReq),
    loadAnalystCases(previewReq),
    loadAnalystAudit(previewReq),
    database.query("SELECT COUNT(*) AS total FROM transactions WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)").then(([rows]) => rows),
  ]);
  return res.render('analyst-dashboard', {
    title: 'Analyst Overview',
    activePage: 'analyst',
    currentUser: req.session.user,
    summary: {
      newTransactions: Number(newTransactionsRows[0]?.total || 0),
      criticalQueue: Number(queueData.summary.critical || 0),
      openCases: Number(casesData.summary.open_cases || 0),
      assignedToMe: Number(casesData.summary.assigned_to_me || 0),
      waiting: Number(casesData.summary.waiting || 0),
      overdue: Number(casesData.summary.overdue || 0),
    },
    queuePreview: queueData.rows.slice(0, 5),
    casePreview: casesData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
}

async function liveTransactionsPage(req, res) {
  const data = await loadAnalystTransactions(req);
  return res.render('analyst-live-transactions', {
    title: 'Live Transaction Feed',
    activePage: 'analyst-live-transactions',
    currentUser: req.session.user,
    ...data,
  });
}

async function workingQueuePage(req, res) {
  const data = await loadAnalystQueue(req);
  return res.render('analyst-working-queue', {
    title: 'Operations Working Queue',
    activePage: 'analyst-working-queue',
    currentUser: req.session.user,
    ...data,
  });
}

async function casesPage(req, res) {
  const data = await loadAnalystCases(req);
  return res.render('analyst-cases', {
    title: 'Cases',
    activePage: 'analyst-cases',
    currentUser: req.session.user,
    ...data,
  });
}

async function auditLogPage(req, res) {
  const data = await loadAnalystAudit(req);
  return res.render('analyst-audit-log', {
    title: 'Audit Log',
    activePage: 'analyst-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
}

async function caseAction(req, res) {
  await ensureStrWorkflowSchema();
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query(
    `SELECT c.transaction_id, t.risk_level
     FROM cases c
     JOIN transactions t ON c.transaction_id = t.transaction_id
     WHERE c.case_id = ?
     LIMIT 1`,
    [req.params.id],
  );
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/analyst/cases');

  // Escalation routing follows the confirmed rule: Critical-risk cases need a Senior
  // Analyst's review first (Scenario 2) before reaching STRO; everything else escalates
  // straight to STRO (Scenario 1).
  const escalation = caseRow.risk_level === 'Critical'
    ? { status: 'Pending Senior Review', actionStatus: 'Pending Senior Review', label: 'Case Escalated to Senior Analyst', destination: 'Senior Analyst', assignedRole: 'Senior Analyst', strStatus: 'Not Started' }
    : { status: 'Escalated', actionStatus: 'Escalated', label: 'Case Referred to STRO', destination: 'STRO', assignedRole: 'STRO', strStatus: 'Recommended' };

  const actionMap = {
    escalate: escalation,
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/analyst/cases');

  await database.execute('UPDATE cases SET status = ?, assigned_role = COALESCE(?, assigned_role), escalation_destination = COALESCE(?, escalation_destination), referred_to_stro_at = CASE WHEN ? = "STRO" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END, referred_to_stro_by = CASE WHEN ? = "STRO" THEN ? ELSE referred_to_stro_by END, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, selected.assignedRole || null, selected.destination || null, selected.destination || null, selected.destination || null, req.session.user.id, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  if (selected.destination === 'STRO') {
    await database.execute(
      `INSERT INTO str_reports (
        str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
        supporting_evidence, senior_analyst_notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE str_status = str_status`,
      [id('STR'), caseRow.transaction_id, req.params.id, 'Possible suspicious activity / STR consideration', notes || selected.label, JSON.stringify(['Transaction behaviour']), notes || selected.label],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/analyst/cases');
}

module.exports = {
  dashboard,
  liveTransactionsPage,
  workingQueuePage,
  casesPage,
  auditLogPage,
  caseAction,
};
