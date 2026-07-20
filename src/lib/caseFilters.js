const database = require('../database');
const { ensureDatabaseResolveColumns, ensureStrWorkflowSchema } = require('./schema');

async function ensureAnalystListSchema() {
  await ensureDatabaseResolveColumns();
  await ensureStrWorkflowSchema();
}

function analystFiltersFromQuery(query) {
  return {
    riskLevel: String(query.riskLevel || '').trim(),
    transactionStatus: String(query.transactionStatus || '').trim(),
    merchantId: String(query.merchantId || '').trim(),
    assessmentStatus: String(query.assessmentStatus || '').trim(),
    assignedTo: String(query.assignedTo || '').trim(),
    assignedRole: String(query.assignedRole || '').trim(),
    escalatedTo: String(query.escalatedTo || '').trim(),
    decision: String(query.decision || '').trim(),
    dueStatus: String(query.dueStatus || '').trim(),
    q: String(query.q || '').trim(),
    sort: String(query.sort || '').trim(),
  };
}

async function getAnalystFilterOptions() {
  const [merchants] = await database.query('SELECT merchant_id, merchant_name FROM merchants WHERE is_active = 1 ORDER BY merchant_name ASC');
  const [users] = await database.query("SELECT user_id, user_name FROM users WHERE user_role IN ('Analyst', 'Senior Analyst', 'STRO') ORDER BY user_name ASC");
  return { merchants, users };
}

function seniorFiltersFromQuery(query) {
  return {
    ...analystFiltersFromQuery(query),
    assignmentStatus: String(query.assignmentStatus || '').trim(),
    referralStatus: String(query.referralStatus || '').trim(),
    actionType: String(query.actionType || '').trim(),
    userId: String(query.userId || '').trim(),
    userRole: String(query.userRole || '').trim(),
    dateFrom: String(query.dateFrom || '').trim(),
    dateTo: String(query.dateTo || '').trim(),
    scope: String(query.scope || '').trim(),
  };
}

module.exports = {
  ensureAnalystListSchema,
  analystFiltersFromQuery,
  getAnalystFilterOptions,
  seniorFiltersFromQuery,
};
