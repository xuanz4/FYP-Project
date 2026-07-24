const { id } = require('../src/lib/ids');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { ensureStrWorkflowSchema } = require('../src/lib/schema');
const { ensureAnalystListSchema, getAnalystFilterOptions, seniorFiltersFromQuery } = require('../src/lib/caseFilters');
const { seniorAuditDefaultActions } = require('../src/constants');
const caseModel = require('../models/caseModel');
const transactionModel = require('../models/transactionModel');
const userModel = require('../models/userModel');
const auditLogModel = require('../models/auditLogModel');
const strReportModel = require('../models/strReportModel');

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
  const total = await caseModel.countForSeniorView(whereSql, values);
  const pagination = paginationMeta(req, total, 15);
  const rows = await caseModel.listForSeniorCasesView(whereSql, values, seniorCaseOrder(filters.sort), pagination.limit, pagination.offset);
  const baseWhere = seniorCaseWhereAndValues({}).where.join(' AND ');
  const summary = await caseModel.seniorCasesSummary(baseWhere, req.session.user.id);
  return { rows, summary, filters, pagination, filterOptions: await getAnalystFilterOptions() };
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
  const transactionId = await caseModel.findTransactionId(req.params.id);
  if (!transactionId) return res.redirect('/senior-analyst/cases');

  const actionMap = {
    escalate: { status: 'Escalated', actionStatus: 'Escalated', label: 'Escalated to STRO' },
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/senior-analyst/cases');

  await caseModel.applySeniorCaseAction({
    caseId: req.params.id, status: selected.status, userId: req.session.user.id, notes,
  });
  await transactionModel.updateActionStatus(transactionId, selected.actionStatus);
  if (selected.status === 'Escalated') {
    await strReportModel.insertRecommendedIfAbsent({
      strId: id('STR'),
      transactionId,
      caseId: req.params.id,
      referralReason: 'Possible suspicious activity',
      referralSummary: notes || selected.label,
      supportingEvidence: ['Transaction behaviour'],
      seniorAnalystNotes: notes || selected.label,
    });
  }
  await auditLogModel.insert({
    auditId: id('AUD'), transactionId, action: selected.label, userId: req.session.user.id, notes: notes || selected.label,
  });

  return res.redirect('/senior-analyst/cases');
}

module.exports = {
  dashboard,
  casesPage,
  auditLogPage,
  caseAction,
};
