const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureStrWorkflowSchema } = require('../src/lib/schema');
const { ensureAnalystListSchema, analystFiltersFromQuery, getAnalystFilterOptions } = require('../src/lib/caseFilters');
const transactionModel = require('../models/transactionModel');
const caseModel = require('../models/caseModel');
const userModel = require('../models/userModel');
const auditLogModel = require('../models/auditLogModel');
const strReportModel = require('../models/strReportModel');

function analystTransactionBaseSelect() {
  return `SELECT t.transaction_id, t.merchant_id, t.amount, t.transaction_code,
                 t.scheme, t.issuer_country, t.entry_mode, t.card_ref, t.txn_time,
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
                  t.scheme, t.issuer_country, t.entry_mode, t.card_ref, t.txn_time,
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
  const total = await transactionModel.countFiltered(whereSql, values);
  const pagination = paginationMeta(req, total, 20);
  const rows = await transactionModel.listWithCaseSummary({
    selectSql: analystTransactionBaseSelect(),
    whereSql,
    groupBySql: analystGroupBy(),
    orderSql: 't.created_at DESC',
    values,
    limit: pagination.limit,
    offset: pagination.offset,
  });
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
  const total = await transactionModel.countForQueue(whereSql, values);
  const pagination = paginationMeta(req, total, 15);
  const rows = await transactionModel.listWithCaseSummary({
    selectSql: analystTransactionBaseSelect(),
    whereSql,
    groupBySql: analystGroupBy(),
    orderSql: queueOrder(filters.sort),
    values,
    limit: pagination.limit,
    offset: pagination.offset,
  });
  const summary = await transactionModel.queueSummary(queueWhereAndValues({}).where.join(' AND '), req.session.user.id);
  return { rows, summary, filters, pagination, filterOptions: await getAnalystFilterOptions() };
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
  const total = await caseModel.countWithTransactionJoin(whereSql, values);
  const pagination = paginationMeta(req, total, 15);
  const rows = await caseModel.listForAnalystCasesView(whereSql, values, pagination.limit, pagination.offset);
  const summary = await caseModel.casesSummary(req.session.user.id);
  return { rows, summary, filters, pagination, filterOptions: await getAnalystFilterOptions() };
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
  const total = await auditLogModel.countFiltered(whereSql, values);
  const pagination = paginationMeta(req, total, 20);
  const rows = await auditLogModel.listFiltered(whereSql, values, pagination.limit, pagination.offset);
  const actions = await auditLogModel.listDistinctActions();
  const users = await userModel.listAllForDropdown();
  return { rows, actions, users, filters, pagination };
}

async function dashboard(req, res) {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [queueData, casesData, auditData, newTransactions] = await Promise.all([
    loadAnalystQueue(previewReq),
    loadAnalystCases(previewReq),
    loadAnalystAudit(previewReq),
    transactionModel.countCreatedSince(24),
  ]);
  return res.render('analyst-dashboard', {
    title: 'Analyst Overview',
    activePage: 'analyst',
    currentUser: req.session.user,
    summary: {
      newTransactions,
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
  const caseRow = await caseModel.findWithTransactionRiskLevel(req.params.id);
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

  await caseModel.applyAnalystCaseAction({
    caseId: req.params.id,
    status: selected.status,
    assignedRole: selected.assignedRole,
    destination: selected.destination,
    userId: req.session.user.id,
    notes,
  });
  await transactionModel.updateActionStatus(caseRow.transaction_id, selected.actionStatus);
  if (selected.destination === 'STRO') {
    await strReportModel.insertRecommendedIfAbsent({
      strId: id('STR'),
      transactionId: caseRow.transaction_id,
      caseId: req.params.id,
      referralReason: 'Possible suspicious activity / STR consideration',
      referralSummary: notes || selected.label,
      supportingEvidence: ['Transaction behaviour'],
      seniorAnalystNotes: notes || selected.label,
    });
  }
  await auditLogModel.insert({
    auditId: id('AUD'), transactionId: caseRow.transaction_id, action: selected.label, userId: req.session.user.id, notes: notes || selected.label,
  });

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
