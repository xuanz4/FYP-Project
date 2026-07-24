const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureAnalystListSchema, getAnalystFilterOptions, seniorFiltersFromQuery } = require('../src/lib/caseFilters');
const { stroAuditDefaultActions } = require('../src/constants');
const caseModel = require('../models/caseModel');
const transactionModel = require('../models/transactionModel');
const strReportModel = require('../models/strReportModel');
const userModel = require('../models/userModel');
const auditLogModel = require('../models/auditLogModel');

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
  const total = await caseModel.countForStroView(whereSql, values);
  const pagination = paginationMeta(req, total, 15);
  const rows = await caseModel.listForStroCasesView(whereSql, values, pagination.limit, pagination.offset);
  const baseWhere = stroCaseWhereAndValues({}).where.join(' AND ');
  const summary = await caseModel.stroCasesSummary(baseWhere);
  return { rows, summary, filters, pagination, filterOptions: await getAnalystFilterOptions() };
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
  const total = await strReportModel.countFiltered(whereSql, values);
  const pagination = paginationMeta(req, total, 15);
  const rows = await strReportModel.listFiltered(whereSql, values, pagination.limit, pagination.offset);
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
  const transactionId = await caseModel.findTransactionId(req.params.id);
  if (!transactionId) return res.redirect('/stro/cases');

  const actionMap = {
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
    str: { status: 'STR Filed', actionStatus: 'STR Filed', label: 'STR Filed' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/stro/cases');

  await caseModel.updateStatusAndNotes({ caseId: req.params.id, status: selected.status, notes });
  await transactionModel.updateActionStatus(transactionId, selected.actionStatus);
  await auditLogModel.insert({
    auditId: id('AUD'), transactionId, action: selected.label, userId: req.session.user.id, notes: notes || selected.label,
  });

  return res.redirect('/stro/cases');
}

module.exports = {
  dashboard,
  casesPage,
  strReportsPage,
  auditLogPage,
  caseAction,
};
