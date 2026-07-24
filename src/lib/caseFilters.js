const { ensureDatabaseResolveColumns, ensureStrWorkflowSchema } = require('./schema');
const merchantModel = require('../../models/merchantModel');
const userModel = require('../../models/userModel');

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
  const merchants = await merchantModel.listActiveForDropdown();
  const users = await userModel.listAnalystRoleUsersForDropdown();
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
