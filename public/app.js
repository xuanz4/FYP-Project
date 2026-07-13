function loadTransactionStatusOverrides() {
  return {};
}

function persistTransactionStatusOverride(transactionId, override) {
  return { transactionId, override };
}

function statusClass(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function applyTransactionOverride(transaction) {
  return transaction;
}

function applyTransactionOverrides() {
  return state.transactions;
}

function isFinalTransactionStatus(status) {
  return ['Pending RFI', 'STR Filed', 'Dismissed as False Positive'].includes(status);
}

function isAssessmentResolved(transaction = {}) {
  return Boolean(
    transaction.finalRiskLevel
    || transaction.resolvedAt
    || transaction.caseStatus === 'Resolved'
    || transaction.assessmentStatus === 'Resolved',
  );
}

function getAssessmentStatus(transaction = {}) {
  if (isAssessmentResolved(transaction)) return 'Resolved';
  if (transaction.assessmentStatus === 'Escalated' || transaction.reviewAction === 'escalate') return 'Escalated';
  if (transaction.assessmentStatus === 'Waiting for Information') return 'Waiting for Information';
  if (transaction.status === 'Pending RFI') return 'Waiting for Information';
  if (transaction.status === 'Escalated') return 'Escalated';
  if (transaction.status === 'Under Review') return 'Investigating';
  return 'New';
}

function hasMeaningfulAnalystNotes(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 10) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
}

const rfiRestrictedPhrases = [
  'suspicious transaction report',
  'suspicious transaction',
  'STR',
  'money laundering',
  'terrorist financing',
  'sanctions match',
  'sanction match',
  'watchlist match',
  'PEP match',
  'adverse media match',
  'risk score',
  'critical risk',
  'high risk customer',
  'AML investigation',
  'police investigation',
  'law enforcement',
  'reported to authorities',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayCustomerName(...sources) {
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === 'string' && source.trim()) return source.trim();
    const value = source.customerName || source.name || source.accountName || source.organisationName;
    if (value && String(value).trim()) return String(value).trim();
    if (source.transaction) {
      const nested = displayCustomerName(source.transaction);
      if (nested !== 'Unknown Customer') return nested;
    }
  }
  return 'Unknown Customer';
}

// Prototype safeguard only. This keyword check does not replace legal or compliance review.
function findRfiRestrictedPhrase(...values) {
  const text = values.filter(Boolean).join(' ');
  return rfiRestrictedPhrases.find((phrase) => {
    const escaped = escapeRegExp(phrase);
    const startsWithWord = /^[a-z0-9]/i.test(phrase) ? '\\b' : '';
    const endsWithWord = /[a-z0-9]$/i.test(phrase) ? '\\b' : '';
    return new RegExp(`${startsWithWord}${escaped}${endsWithWord}`, 'i').test(text);
  }) || null;
}

function formatRfiAmount(transaction) {
  return `${transaction.currency || 'SGD'} ${Number(transaction.amount || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const detailSeedElement = document.querySelector('#transactionDetailData');
let detailSeed = null;
if (detailSeedElement) {
  try {
    detailSeed = JSON.parse(detailSeedElement.textContent || 'null');
  } catch (error) {
    detailSeed = null;
  }
}

const detailPageElement = document.querySelector('[data-transaction-detail-page]');
const initialEmailTestMode = detailPageElement?.dataset.emailTestMode === 'true';

const state = {
  transactions: [],
  alerts: [],
  cases: [],
  ruleSets: [],
  auditLogs: [],
  charts: {},
  analytics: {},
  metrics: {},
  customerRiskProfiles: [],
  watchlist: [],
  riskFilter: 'All',
  transactionStatusFilter: 'All',
  companyFilter: 'All',
  kycStatusFilter: 'All',
  screeningStatusFilter: 'All',
  customerRiskLevelFilter: 'All',
  investigationStatusFilter: 'All',
  investigationRiskFilter: 'All',
  investigationAnalystFilter: 'All',
  investigationDateFilter: 'All',
  investigationSearchQuery: '',
  auditActionFilter: 'All',
  auditActorFilter: 'All',
  auditVisibleCount: 20,
  analyticsPeriodFilter: 'All',
  analyticsRiskFilter: 'All',
  analyticsStatusFilter: 'All',
  companyExposureSort: 'averageRisk',
  showAllAnalyticsCustomers: false,
  detailSeed,
  rfiEmailConfig: { testMode: initialEmailTestMode },
  detailTransactionId: detailPageElement?.dataset.transactionId || detailSeed?.id || null,
};

const workflowStatuses = ['New', 'Under Review', 'Waiting for Information', 'Escalated', 'Resolved', 'False Positive'];
const transactionStatusOrder = [
  'Flagged',
  'Pending RFI',
  'STR Filed',
  'Escalated',
  'Dismissed as False Positive',
  'Cleared',
];

const money = new Intl.NumberFormat('en-SG', {
  style: 'currency',
  currency: 'SGD',
  maximumFractionDigits: 0,
});

const time = new Intl.DateTimeFormat('en-SG', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const elements = {
  totalMetric: document.querySelector('#totalMetric'),
  flaggedMetric: document.querySelector('#flaggedMetric'),
  clearedMetric: document.querySelector('#clearedMetric'),
  flagRateMetric: document.querySelector('#flagRateMetric'),
  activeAlertsMetric: document.querySelector('#activeAlertsMetric'),
  waitingInfoMetric: document.querySelector('#waitingInfoMetric'),
  escalatedCasesMetric: document.querySelector('#escalatedCasesMetric'),
  valueMetric: document.querySelector('#valueMetric'),
  dashboardRiskChart: document.querySelector('#dashboardRiskChart'),
  dashboardWorkflowChart: document.querySelector('#dashboardWorkflowChart'),
  simulateFeedback: document.querySelector('#simulateFeedback'),
  transactionRows: document.querySelector('#transactionRows'),
  operationsQueue: document.querySelector('#operationsQueue'),
  alertList: document.querySelector('#alertList'),
  caseList: document.querySelector('#caseList'),
  auditList: document.querySelector('#auditList'),
  investigationStatusFilter: document.querySelector('#investigationStatusFilter'),
  investigationRiskFilter: document.querySelector('#investigationRiskFilter'),
  investigationAnalystFilter: document.querySelector('#investigationAnalystFilter'),
  investigationDateFilter: document.querySelector('#investigationDateFilter'),
  investigationSearchInput: document.querySelector('#investigationSearchInput'),
  investigationSummaryNew: document.querySelector('#investigationSummaryNew'),
  investigationSummaryUnderReview: document.querySelector('#investigationSummaryUnderReview'),
  investigationSummaryWaiting: document.querySelector('#investigationSummaryWaiting'),
  investigationSummaryEscalated: document.querySelector('#investigationSummaryEscalated'),
  investigationSummaryOverdue: document.querySelector('#investigationSummaryOverdue'),
  investigationSummaryResolvedToday: document.querySelector('#investigationSummaryResolvedToday'),
  auditActionFilter: document.querySelector('#auditActionFilter'),
  auditActorFilter: document.querySelector('#auditActorFilter'),
  auditViewMore: document.querySelector('#auditViewMore'),
  auditViewAll: document.querySelector('#auditViewAll'),
  ruleList: document.querySelector('#ruleList'),
  companyRuleTabs: document.querySelector('#companyRuleTabs'),
  companyRuleDetail: document.querySelector('#companyRuleDetail'),
  riskChart: document.querySelector('#riskChart'),
  dispositionChart: document.querySelector('#dispositionChart'),
  alertStatusChart: document.querySelector('#alertStatusChart'),
  countryChart: document.querySelector('#countryChart'),
  analysisTotalTransactions: document.querySelector('#analysisTotalTransactions'),
  analysisFlagRate: document.querySelector('#analysisFlagRate'),
  analysisHighRiskRate: document.querySelector('#analysisHighRiskRate'),
  analysisOpenAssessments: document.querySelector('#analysisOpenAssessments'),
  analysisEscalated: document.querySelector('#analysisEscalated'),
  analysisOverdue: document.querySelector('#analysisOverdue'),
  analysisInsights: document.querySelector('#analysisInsights'),
  analysisDrivers: document.querySelector('#analysisDrivers'),
  analysisCountries: document.querySelector('#analysisCountries'),
  analysisCompanies: document.querySelector('#analysisCompanies'),
  analysisCustomers: document.querySelector('#analysisCustomers'),
  analyticsPeriodFilter: document.querySelector('#analyticsPeriodFilter'),
  analyticsRiskFilter: document.querySelector('#analyticsRiskFilter'),
  analyticsStatusFilter: document.querySelector('#analyticsStatusFilter'),
  companyExposureSort: document.querySelector('#companyExposureSort'),
  customerWatchlistToggle: document.querySelector('#customerWatchlistToggle'),
  customerRiskRows: document.querySelector('#customerRiskRows'),
  dueDiligenceTotalCustomers: document.querySelector('#dueDiligenceTotalCustomers'),
  dueDiligencePendingKyc: document.querySelector('#dueDiligencePendingKyc'),
  dueDiligencePotentialMatches: document.querySelector('#dueDiligencePotentialMatches'),
  dueDiligenceHighRiskCustomers: document.querySelector('#dueDiligenceHighRiskCustomers'),
  dueDiligenceOpenAlerts: document.querySelector('#dueDiligenceOpenAlerts'),
  kycStatusFilter: document.querySelector('#kycStatusFilter'),
  screeningStatusFilter: document.querySelector('#screeningStatusFilter'),
  customerRiskLevelFilter: document.querySelector('#customerRiskLevelFilter'),
  customerScreeningForm: document.querySelector('#customerScreeningForm'),
  customerScreeningResults: document.querySelector('#customerScreeningResults'),
  paymentScreeningForm: document.querySelector('#paymentScreeningForm'),
  paymentScreeningResults: document.querySelector('#paymentScreeningResults'),
  watchlistRows: document.querySelector('#watchlistRows'),
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  riskFilter: document.querySelector('#riskFilter'),
  transactionStatusFilter: document.querySelector('#transactionStatusFilter'),
  companyFilter: document.querySelector('#companyFilter'),
  simulateBtn: document.querySelector('#simulateBtn'),
  transactionDetailPage: document.querySelector('[data-transaction-detail-page]'),
  transactionDetailStatus: document.querySelector('#transactionDetailStatus'),
  transactionDetailConfirmation: document.querySelector('#transactionDetailConfirmation'),
  transactionDetailActionButtons: document.querySelector('#transactionDetailActionButtons'),
  transactionActionModal: document.querySelector('#transactionActionModal'),
  transactionActionForm: document.querySelector('#transactionActionForm'),
  transactionActionTitle: document.querySelector('#transactionActionTitle'),
  transactionActionSubmit: document.querySelector('#transactionActionSubmit'),
  transactionActionName: document.querySelector('#transactionActionName'),
  transactionActionAmount: document.querySelector('#transactionActionAmount'),
  transactionActionCountry: document.querySelector('#transactionActionCountry'),
  transactionActionCategory: document.querySelector('#transactionActionCategory'),
  transactionActionType: document.querySelector('#transactionActionType'),
  rfiEmailModal: document.querySelector('#rfiEmailModal'),
  rfiEmailForm: document.querySelector('#rfiEmailForm'),
  rfiEmailFeedback: document.querySelector('#rfiEmailFeedback'),
  rfiEmailPreview: document.querySelector('#rfiEmailPreview'),
  rfiPreviewButton: document.querySelector('#rfiPreviewButton'),
  rfiSendButton: document.querySelector('#rfiSendButton'),
  rfiRecipientType: document.querySelector('#rfiRecipientType'),
  rfiRecipientName: document.querySelector('#rfiRecipientName'),
  rfiRecipientEmail: document.querySelector('#rfiRecipientEmail'),
  rfiRecipientEmailLabel: document.querySelector('#rfiRecipientEmailLabel'),
  rfiRecipientEmailHelp: document.querySelector('#rfiRecipientEmailHelp'),
  rfiTestModeNotice: document.querySelector('#rfiTestModeNotice'),
  resolveAssessmentForm: document.querySelector('#resolveAssessmentForm'),
  resolveAssessmentFeedback: document.querySelector('#resolveAssessmentFeedback'),
  resolveAssessmentSection: document.querySelector('#resolveAssessmentSection'),
  investigationActionsSection: document.querySelector('#investigationActionsSection'),
  assessmentOutcomeSection: document.querySelector('#assessmentOutcomeSection'),
  assessmentStatusBadge: document.querySelector('#assessmentStatusBadge'),
  assessmentDecisionBadge: document.querySelector('#assessmentDecisionBadge'),
  escalatedAssessmentMessage: document.querySelector('#escalatedAssessmentMessage'),
  transactionActivityLog: document.querySelector('#transactionActivityLog'),
  assessmentFinalRiskScoreSummary: document.querySelector('#assessmentFinalRiskScoreSummary'),
  assessmentFinalRiskLevelSummary: document.querySelector('#assessmentFinalRiskLevelSummary'),
  assessmentFinalRiskScore: document.querySelector('#assessmentFinalRiskScore'),
  assessmentFinalRiskLevel: document.querySelector('#assessmentFinalRiskLevel'),
  assessmentDecision: document.querySelector('#assessmentDecision'),
  assessmentDecisionDetail: document.querySelector('#assessmentDecisionDetail'),
  assessmentResolutionReason: document.querySelector('#assessmentResolutionReason'),
  assessmentResolutionReasonDetail: document.querySelector('#assessmentResolutionReasonDetail'),
  assessmentAnalystNotes: document.querySelector('#assessmentAnalystNotes'),
  assessmentResolvedAt: document.querySelector('#assessmentResolvedAt'),
  assessmentResolvedAtDetail: document.querySelector('#assessmentResolvedAtDetail'),
};

function setSnapshot(snapshot) {
  state.transactions = snapshot.transactions || [];
  state.alerts = snapshot.alerts || [];
  state.cases = snapshot.cases || [];
  state.auditLogs = snapshot.auditLogs || [];
  state.ruleSets = snapshot.ruleSets || snapshot.rules || [];
  state.charts = snapshot.charts || {};
  state.analytics = snapshot.analytics || {};
  state.metrics = snapshot.metrics || {};
  state.customerRiskProfiles = snapshot.customerRiskProfiles || [];
  state.watchlist = snapshot.watchlist || [];
  populateCompanyFilter();
  populateInvestigationFilters();
  render();
}

function upsert(collection, item) {
  const index = collection.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    collection[index] = item;
  } else {
    collection.unshift(item);
  }
}

function populateCompanyFilter() {
  if (!elements.companyFilter) return;
  const current = elements.companyFilter.value || state.companyFilter;
  elements.companyFilter.innerHTML = '<option value="All">All Companies</option>' + state.ruleSets.map((company) => `
    <option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>
  `).join('');
  elements.companyFilter.value = state.ruleSets.some((company) => company.id === current) ? current : 'All';
  state.companyFilter = elements.companyFilter.value;
}

function populateInvestigationFilters() {
  if (elements.investigationAnalystFilter) {
    const current = elements.investigationAnalystFilter.value || state.investigationAnalystFilter;
    const analysts = new Set();
    state.alerts.forEach((alert) => analysts.add(alert.analyst || 'Unassigned'));
    state.cases.forEach((item) => analysts.add(item.owner || 'Operations Team'));
    const values = [...analysts].filter(Boolean).sort();
    elements.investigationAnalystFilter.innerHTML = '<option value="All">All Analysts</option>' + values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
    elements.investigationAnalystFilter.value = values.includes(current) ? current : 'All';
    state.investigationAnalystFilter = elements.investigationAnalystFilter.value;
  }

  if (elements.auditActionFilter) {
    const current = elements.auditActionFilter.value || state.auditActionFilter;
    const values = [...new Set(state.auditLogs.map((entry) => entry.action).filter(Boolean))].sort();
    elements.auditActionFilter.innerHTML = '<option value="All">All Actions</option>' + values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
    elements.auditActionFilter.value = values.includes(current) ? current : 'All';
    state.auditActionFilter = elements.auditActionFilter.value;
  }

  if (elements.auditActorFilter) {
    const current = elements.auditActorFilter.value || state.auditActorFilter;
    const values = [...new Set(state.auditLogs.map((entry) => entry.actor).filter(Boolean))].sort();
    elements.auditActorFilter.innerHTML = '<option value="All">All Actors</option>' + values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
    elements.auditActorFilter.value = values.includes(current) ? current : 'All';
    state.auditActorFilter = elements.auditActorFilter.value;
  }
}

function matchesCompany(item) {
  return state.companyFilter === 'All' || item.companyId === state.companyFilter;
}

function withinDateRange(value, range) {
  if (range === 'All') return true;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const periodMs = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }[range];
  return !periodMs || timestamp >= Date.now() - periodMs;
}

function getFilteredTransactions() {
  return state.transactions.filter(matchesCompany);
}

function getFilteredCustomerRiskProfiles() {
  return state.customerRiskProfiles
    .filter(matchesCompany)
    .filter((profile) => state.kycStatusFilter === 'All' || profile.kycStatus === state.kycStatusFilter)
    .filter((profile) => state.screeningStatusFilter === 'All' || profile.screeningStatus === state.screeningStatusFilter)
    .filter((profile) => state.customerRiskLevelFilter === 'All' || profile.riskBand === state.customerRiskLevelFilter);
}

function matchesAnalyticsFilters(transaction) {
  if (!matchesCompany(transaction)) return false;
  if (state.analyticsRiskFilter !== 'All' && transaction.riskBand !== state.analyticsRiskFilter) return false;
  if (state.analyticsStatusFilter !== 'All' && transaction.status !== state.analyticsStatusFilter) return false;

  if (state.analyticsPeriodFilter !== 'All') {
    const createdAt = new Date(transaction.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return false;
    const now = Date.now();
    const periodMs = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }[state.analyticsPeriodFilter];
    if (periodMs && createdAt < now - periodMs) return false;
  }

  return true;
}

function getAnalyticsTransactions() {
  return state.transactions.filter(matchesAnalyticsFilters);
}

function getAnalyticsAlerts() {
  const transactionIds = new Set(getAnalyticsTransactions().map((transaction) => transaction.id));
  return state.alerts.filter((alert) => {
    if (!matchesCompany(alert)) return false;
    const ids = alert.transactionIds || [alert.transactionId];
    return ids.some((transactionId) => transactionIds.has(transactionId));
  });
}

function getAnalyticsCases() {
  const alertIds = new Set(getAnalyticsAlerts().map((alert) => alert.id));
  return state.cases.filter((item) => matchesCompany(item) && alertIds.has(item.alertId));
}

function getTransactionById(transactionId) {
  return state.transactions.find((transaction) => transaction.id === transactionId)
    || (state.detailSeed && state.detailSeed.id === transactionId ? state.detailSeed : null);
}

function getFilteredAlerts() {
  return state.alerts.filter(matchesCompany);
}

function getFilteredCases() {
  return state.cases.filter(matchesCompany);
}

function getFilteredAuditLogs() {
  return state.auditLogs
    .filter(matchesCompany)
    .filter((entry) => state.auditActionFilter === 'All' || entry.action === state.auditActionFilter)
    .filter((entry) => state.auditActorFilter === 'All' || entry.actor === state.auditActorFilter);
}

function getCaseByAlertId(alertId) {
  return state.cases.find((item) => item.alertId === alertId) || null;
}

function getAlertById(alertId) {
  return state.alerts.find((alert) => alert.id === alertId) || null;
}

function getLatestTransactionForAlert(alert) {
  const ids = alert?.transactionIds || [alert?.transactionId];
  return ids
    .map((transactionId) => state.transactions.find((txn) => txn.id === transactionId))
    .filter(Boolean)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0] || null;
}

function getCaseAmountAndDirection(item) {
  const alert = getAlertById(item.alertId);
  const transaction = getLatestTransactionForAlert(alert);
  return {
    amount: transaction?.amount ?? null,
    direction: transaction?.direction || 'Unknown',
    transaction,
    alert,
  };
}

function investigationTextMatches(values) {
  const query = state.investigationSearchQuery.trim().toLowerCase();
  if (!query) return true;
  return values.filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
}

function matchesInvestigationStatus(status) {
  return state.investigationStatusFilter === 'All' || status === state.investigationStatusFilter;
}

function matchesInvestigationRisk(risk) {
  return state.investigationRiskFilter === 'All' || risk === state.investigationRiskFilter;
}

function matchesInvestigationAnalyst(value) {
  return state.investigationAnalystFilter === 'All' || value === state.investigationAnalystFilter;
}

function getFilteredInvestigationAlerts() {
  return getFilteredAlerts()
    .filter((alert) => matchesInvestigationStatus(alert.status))
    .filter((alert) => matchesInvestigationRisk(alert.severity || alert.riskLevel))
    .filter((alert) => matchesInvestigationAnalyst(alert.analyst || 'Unassigned'))
    .filter((alert) => withinDateRange(alert.updatedAt || alert.createdAt, state.investigationDateFilter))
    .filter((alert) => investigationTextMatches([
      alert.customerName,
      alert.transactionId,
      alert.id,
      getCaseByAlertId(alert.id)?.id,
    ]));
}

function getFilteredInvestigationCases() {
  return getFilteredCases()
    .filter((item) => matchesInvestigationStatus(item.status))
    .filter((item) => matchesInvestigationRisk(item.priority))
    .filter((item) => matchesInvestigationAnalyst(item.owner || 'Operations Team'))
    .filter((item) => withinDateRange(item.updatedAt || item.createdAt || item.dueAt, state.investigationDateFilter))
    .filter((item) => {
      const { alert, transaction } = getCaseAmountAndDirection(item);
      return investigationTextMatches([
        item.id,
        item.customerName,
        item.alertId,
        alert?.transactionId,
        transaction?.id,
      ]);
    });
}

function getWorkflowItemsForSummary() {
  const caseAlertIds = new Set(getFilteredCases().map((item) => item.alertId));
  const caseItems = getFilteredCases().map((item) => ({
    status: item.status,
    dueAt: item.dueAt,
    updatedAt: item.updatedAt,
    resolvedAt: item.resolvedAt,
  }));
  const alertOnlyItems = getFilteredAlerts()
    .filter((alert) => !caseAlertIds.has(alert.id))
    .map((alert) => ({
      status: alert.status,
      dueAt: null,
      updatedAt: alert.updatedAt,
      resolvedAt: alert.resolvedAt,
    }));
  return [...caseItems, ...alertOnlyItems];
}

function getFilteredMetrics() {
  const transactions = getFilteredTransactions();
  const alerts = getFilteredAlerts();
  const cases = getFilteredCases();
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const cleared = transactions.filter((txn) => txn.status === 'Cleared').length;
  const activeAlerts = alerts.filter((alert) => !['Resolved', 'False Positive'].includes(alert.status)).length;
  const waitingForInformation = [
    ...alerts.filter((alert) => alert.status === 'Waiting for Information'),
    ...cases.filter((item) => item.status === 'Waiting for Information'),
  ].length;
  const escalatedCases = cases.filter((item) => item.status === 'Escalated').length;
  const valueScreened = transactions.reduce((sum, txn) => sum + txn.amount, 0);
  return {
    total,
    flagged,
    cleared,
    activeAlerts,
    waitingForInformation,
    escalatedCases,
    valueScreened,
    flagRate: total ? Math.round((flagged / total) * 100) : 0,
  };
}

function getDashboardCharts() {
  const transactions = getFilteredTransactions();
  const riskOrder = ['Critical', 'High', 'Medium', 'Low'];
  return {
    riskCounts: riskOrder.map((risk) => ({
      label: risk,
      value: transactions.filter((txn) => (txn.initialRiskLevel || txn.riskBand) === risk).length,
    })),
    workflowStatus: ['New', 'Under Review', 'Waiting for Information', 'Escalated', 'Resolved'].map((status) => ({
      label: status,
      value: getWorkflowItemsForSummary().filter((item) => item.status === status).length,
    })),
  };
}

function getFilteredCharts() {
  const transactions = getAnalyticsTransactions();
  const alerts = getAnalyticsAlerts();
  const riskOrder = ['Critical', 'High', 'Medium', 'Low'];
  const alertStatusesForChart = workflowStatuses;
  const countryCounts = transactions.reduce((summary, txn) => {
    summary[txn.country] = (summary[txn.country] || 0) + 1;
    return summary;
  }, {});

  return {
    riskCounts: riskOrder.map((risk) => ({ label: risk, value: transactions.filter((txn) => txn.riskBand === risk).length })),
    disposition: [
      { label: 'Flagged', value: transactions.filter((txn) => txn.status === 'Flagged').length },
      { label: 'Cleared', value: transactions.filter((txn) => txn.status === 'Cleared').length },
    ],
    alertStatus: alertStatusesForChart.map((status) => ({ label: status, value: alerts.filter((alert) => alert.status === status).length })),
    topCountries: Object.entries(countryCounts)
      .map(([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 6),
  };
}
function render() {
  renderMetrics();
  renderDashboardCharts();
  renderCharts();
  renderAnalytics();
  renderTransactions();
  renderOperationsQueue();
  renderAlerts();
  renderCases();
  renderAuditLogs();
  renderRules();
  renderCustomerRisk();
  renderWatchlist();
  renderTransactionDetailPage();
}

// Updates the dashboard metric cards defined in views/dashboard.ejs using the currently selected company filter.
function renderMetrics() {
  if (!elements.totalMetric) return;
  const metrics = getFilteredMetrics();
  elements.totalMetric.textContent = metrics.total || 0;
  if (elements.flaggedMetric) elements.flaggedMetric.textContent = metrics.flagged || 0;
  if (elements.clearedMetric) elements.clearedMetric.textContent = metrics.cleared || 0;
  elements.flagRateMetric.textContent = `${metrics.flagRate || 0}% flag rate. Based on the current simulated monitoring window.`;
  elements.activeAlertsMetric.textContent = metrics.activeAlerts || 0;
  if (elements.waitingInfoMetric) elements.waitingInfoMetric.textContent = metrics.waitingForInformation || 0;
  if (elements.escalatedCasesMetric) elements.escalatedCasesMetric.textContent = metrics.escalatedCases || 0;
  elements.valueMetric.textContent = money.format(metrics.valueScreened || 0);
}

function renderDashboardCharts() {
  if (!elements.dashboardRiskChart && !elements.dashboardWorkflowChart) return;
  const charts = getDashboardCharts();
  renderDonutChart(elements.dashboardRiskChart, charts.riskCounts || []);
  renderBarChart(elements.dashboardWorkflowChart, charts.workflowStatus || []);
}

// charts under analytics
function renderCharts() {
  const charts = getFilteredCharts();
  renderDonutChart(elements.riskChart, charts.riskCounts || []);
  renderDonutChart(elements.dispositionChart, charts.disposition || []);
  renderBarChart(elements.alertStatusChart, charts.alertStatus || []);
  renderBarChart(elements.countryChart, charts.topCountries || []);
}

function renderBarChart(target, rows) {
  if (!target) return;
  const max = Math.max(...rows.map((row) => row.value), 1);
  target.innerHTML = rows.map((row) => {
    const width = Math.max((row.value / max) * 100, row.value ? 7 : 0);
    return `
      <div class="chart-row">
        <div class="chart-label">
          <span>${escapeHtml(row.label)}</span>
          <strong>${row.value}</strong>
        </div>
        <div class="chart-track"><span style="width: ${width}%"></span></div>
      </div>
    `;
  }).join('') || '<p class="muted">No chart data yet.</p>';
}

function chartColor(index) {
  return ['#c44b5f', '#e6a23c', '#2d7ff9', '#3b8f84', '#68778d', '#9b6bd3'][index % 6];
}

function renderDonutChart(target, rows) {
  if (!target) return;
  const total = rows.reduce((sum, row) => sum + Number(row.value || 0), 0);
  if (!total) {
    target.innerHTML = '<p class="muted">No chart data yet.</p>';
    return;
  }

  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    const end = cursor + ((Number(row.value || 0) / total) * 100);
    cursor = end;
    return `${chartColor(index)} ${start}% ${end}%`;
  }).join(', ');

  target.innerHTML = `
    <div class="donut-visual" style="background: conic-gradient(${segments})">
      <span>${total}</span>
      <small>Total</small>
    </div>
    <div class="donut-legend">
      ${rows.map((row, index) => `
        <div>
          <i style="background:${chartColor(index)}"></i>
          <span>${escapeHtml(row.label)}</span>
          <strong>${row.value}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function summarizeBy(items, keyGetter) {
  return items.reduce((summary, txn) => {
    const label = keyGetter(txn) || 'Unknown';
    summary[label] ||= { label, count: 0, flagged: 0, amount: 0, score: 0, customerId: txn.customerId };
    summary[label].count += 1;
    summary[label].flagged += txn.status === 'Flagged' ? 1 : 0;
    summary[label].amount += Number(txn.amount) || 0;
    summary[label].score += Number(txn.riskScore) || 0;
    return summary;
  }, {});
}

function topSummaries(summary, limit = 5) {
  return Object.values(summary)
    .sort((left, right) => right.score - left.score || right.count - left.count)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      flagRate: percent(item.flagged, item.count),
      averageRisk: item.count ? Math.round(item.score / item.count) : 0,
    }));
}

function getFilteredAnalytics() {
  const transactions = getAnalyticsTransactions();
  const alerts = getAnalyticsAlerts();
  const cases = getAnalyticsCases();
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const highRisk = transactions.filter((txn) => ['High', 'Critical'].includes(txn.riskBand)).length;
  const activeAlerts = alerts.filter((alert) => !['Resolved', 'False Positive'].includes(alert.status)).length;
  const escalatedAlerts = alerts.filter((alert) => alert.status === 'Escalated').length;
  const overdueCases = cases.filter((item) => item.dueAt && new Date(item.dueAt).getTime() < Date.now()).length;
  const drivers = {};

  transactions.forEach((txn) => {
    (txn.matchedRules || []).forEach((rule) => {
      drivers[rule.name] ||= { label: rule.name, count: 0, score: 0, weight: 0 };
      drivers[rule.name].count += 1;
      drivers[rule.name].weight += Number(rule.weight) || 0;
      drivers[rule.name].score += Number(rule.weight) || 0;
    });
  });

  const insights = [];
  if (percent(flagged, total) >= 35) {
    insights.push({
      observation: 'Flag rate is elevated.',
      impact: 'Analyst workload may increase for the selected view.',
      action: 'Review rule thresholds and recent merchant activity.',
    });
  }
  if (highRisk >= 5) {
    insights.push({
      observation: 'High and critical risk transactions are building up.',
      impact: 'Priority queues may need faster triage.',
      action: 'Prioritize open high-risk assessments.',
    });
  }
  if (activeAlerts >= 10) {
    insights.push({
      observation: 'Open assessment workload is high.',
      impact: 'SLA pressure may increase if ownership is unclear.',
      action: 'Assign analysts before due dates approach.',
    });
  }
  if (escalatedAlerts > 0) {
    insights.push({
      observation: 'Escalated cases are present.',
      impact: 'Senior review input is needed before final resolution.',
      action: 'Check escalation notes and next required actions.',
    });
  }
  if (overdueCases > 0) {
    insights.push({
      observation: 'Some cases are past due.',
      impact: 'Compliance review timelines may be missed.',
      action: 'Reorder the queue by due date and priority.',
    });
  }
  if (!insights.length) {
    insights.push({
      observation: 'Current monitoring activity is stable.',
      impact: 'No immediate workload spike is visible.',
      action: 'Continue monitoring for new high-risk rule clusters.',
    });
  }

  return {
    summary: {
      total,
      flagged,
      highRisk,
      activeAlerts,
      escalatedAlerts,
      overdueCases,
      flagRate: percent(flagged, total),
      highRiskRate: percent(highRisk, total),
    },
    insights,
    drivers: topSummaries(drivers, 6).map((item) => ({
      ...item,
      averageWeight: item.count ? Math.round(item.weight / item.count) : 0,
    })),
    countries: topSummaries(summarizeBy(transactions, (txn) => txn.country), 6),
    companies: topSummaries(summarizeBy(transactions, (txn) => txn.companyName || txn.companyId), 8),
    customers: topSummaries(summarizeBy(transactions, (txn) => txn.customerName || txn.customerId), 20),
  };
}

function renderAnalytics() {
  if (!elements.analysisInsights) return;
  const analytics = getFilteredAnalytics();
  if (elements.analysisTotalTransactions) elements.analysisTotalTransactions.textContent = analytics.summary.total;
  elements.analysisFlagRate.textContent = `${analytics.summary.flagRate}%`;
  elements.analysisHighRiskRate.textContent = `${analytics.summary.highRiskRate}%`;
  if (elements.analysisOpenAssessments) elements.analysisOpenAssessments.textContent = analytics.summary.activeAlerts;
  elements.analysisEscalated.textContent = analytics.summary.escalatedAlerts;
  elements.analysisOverdue.textContent = analytics.summary.overdueCases;

  elements.analysisInsights.innerHTML = analytics.insights.slice(0, 3).map((insight) => `
    <article class="insight-item">
      <span>Observation</span>
      <strong>${escapeHtml(insight.observation)}</strong>
      <span>Impact</span>
      <p>${escapeHtml(insight.impact)}</p>
      <span>Suggested action</span>
      <p>${escapeHtml(insight.action)}</p>
    </article>
  `).join('');

  renderDriverRows(elements.analysisDrivers, analytics.drivers);

  const sortedCompanies = [...analytics.companies].sort((left, right) => {
    const sortKey = state.companyExposureSort;
    return Number(right[sortKey] || 0) - Number(left[sortKey] || 0);
  });

  renderExposureTable(elements.analysisCountries, analytics.countries, 'Country', 'Total Value');
  renderExposureTable(elements.analysisCompanies, sortedCompanies, 'Company', 'Transaction Value');
  const customerRows = state.showAllAnalyticsCustomers ? analytics.customers : analytics.customers.slice(0, 5);
  renderExposureTable(elements.analysisCustomers, customerRows, 'Customer', 'Screened Value');
  if (elements.customerWatchlistToggle) {
    const hasMore = analytics.customers.length > 5;
    elements.customerWatchlistToggle.classList.toggle('is-hidden', !hasMore);
    elements.customerWatchlistToggle.textContent = state.showAllAnalyticsCustomers ? 'Show Top 5' : 'View All';
  }
}

function renderDriverRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows.map((item, index) => `
    <article class="driver-row">
      <span class="rank-pill">${index + 1}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <span>${item.count} matches</span>
      <span>Average risk contribution ${item.averageWeight}</span>
    </article>
  `).join('') || '<p class="muted">No rule drivers yet.</p>';
}

function renderExposureTable(target, rows, firstColumnLabel, valueColumnLabel) {
  if (!target) return;
  target.innerHTML = rows.length ? `
    <div class="table-wrap analytics-table-wrap">
      <table class="analytics-table">
        <thead>
          <tr>
            <th>${escapeHtml(firstColumnLabel)}</th>
            <th>Transactions</th>
            <th>Flagged</th>
            <th>Flag Rate</th>
            <th>Average Weighted Risk Score</th>
            <th>${escapeHtml(valueColumnLabel)}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => `
            <tr>
              <td><strong>${escapeHtml(item.label)}</strong></td>
              <td>${item.count}</td>
              <td>${item.flagged}</td>
              <td>${item.flagRate}%</td>
              <td>${item.averageRisk}</td>
              <td>${money.format(item.amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="muted">No analysis data yet.</p>';
}

function renderAnalysisRows(target, rows, renderer) {
  if (!target) return;
  target.innerHTML = rows.map((row) => `
    <article class="analysis-row">
      ${renderer(row)}
    </article>
  `).join('') || '<p class="muted">No analysis data yet.</p>';
}

// Shows the customer risk table on views/diligence.ejs so officers can see higher-risk customers.
function renderCustomerRisk() {
  if (!elements.customerRiskRows) return;
  const profiles = getFilteredCustomerRiskProfiles();
  const totalOpenAlerts = profiles.reduce((sum, profile) => sum + Number(profile.openAlerts || 0), 0);

  if (elements.dueDiligenceTotalCustomers) elements.dueDiligenceTotalCustomers.textContent = profiles.length;
  if (elements.dueDiligencePendingKyc) {
    elements.dueDiligencePendingKyc.textContent = profiles.filter((profile) => profile.kycStatus === 'Pending Review').length;
  }
  if (elements.dueDiligencePotentialMatches) {
    elements.dueDiligencePotentialMatches.textContent = profiles.filter((profile) => profile.screeningStatus === 'Potential Match').length;
  }
  if (elements.dueDiligenceHighRiskCustomers) {
    elements.dueDiligenceHighRiskCustomers.textContent = profiles.filter((profile) => ['High', 'Critical'].includes(profile.riskBand)).length;
  }
  if (elements.dueDiligenceOpenAlerts) elements.dueDiligenceOpenAlerts.textContent = totalOpenAlerts;

  const rows = profiles
    .slice(0, 50)
    .map((profile) => `
      <tr>
        <td>
          <strong>${escapeHtml(displayCustomerName(profile))}</strong>
          <div class="muted">${escapeHtml(profile.customerId)}</div>
        </td>
        <td>${escapeHtml(profile.companyName || 'Company')}</td>
        <td><span class="status-chip">${escapeHtml(profile.kycStatus)}</span></td>
        <td><span class="status-chip status-${statusClass(profile.screeningStatus)}">${escapeHtml(profile.screeningStatus)}</span></td>
        <td>
          <strong>${profile.transactionCount}</strong>
          <div class="muted">${money.format(profile.totalValue)}</div>
        </td>
        <td>${profile.openAlerts}</td>
        <td>
          <span class="risk-stack risk-${statusClass(profile.riskBand)}">
            <strong>${escapeHtml(profile.riskBand)}</strong>
            <small>Score ${profile.riskScore}</small>
          </span>
        </td>
        <td>${renderRiskDriverPreview(profile.riskDrivers || [])}</td>
        <td>
          <details class="driver-details">
            <summary>View Details</summary>
            <ul>
              ${(profile.riskDrivers || []).map((driver) => `<li>${escapeHtml(driver)}</li>`).join('')}
            </ul>
          </details>
        </td>
      </tr>
    `)
    .join('');

  elements.customerRiskRows.innerHTML = rows || '<tr><td colspan="9">No customer risk profiles yet.</td></tr>';
}

function renderRiskDriverPreview(drivers) {
  const visible = drivers.slice(0, 3);
  const hiddenCount = Math.max(drivers.length - visible.length, 0);
  return `
    <div class="driver-chip-list">
      ${visible.map((driver) => `<span>${escapeHtml(driver)}</span>`).join('')}
      ${hiddenCount ? `<em>+${hiddenCount} more</em>` : ''}
    </div>
  `;
}

function renderWatchlist() {
  if (!elements.watchlistRows) return;
  elements.watchlistRows.innerHTML = state.watchlist.length ? `
    <div class="table-wrap watchlist-table-wrap">
      <table class="watchlist-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Country</th>
            <th>Severity</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          ${state.watchlist.map((entry) => `
            <tr>
              <td><strong>${escapeHtml(entry.name)}</strong></td>
              <td>${escapeHtml(entry.type)}</td>
              <td>${escapeHtml(entry.country)}</td>
              <td><span class="badge risk-${statusClass(entry.risk)}">${escapeHtml(entry.risk)}</span></td>
              <td>${escapeHtml(entry.reason)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="muted">No watchlist sources configured.</p>';
}

function renderScreeningResult(target, result) {
  if (!target) return;
  const matches = result.matches || [];
  const primary = matches[0] || null;
  target.innerHTML = `
    <article class="screening-result-card">
      <div class="screening-result-top">
        <span class="badge risk-${statusClass(primary?.risk || (result.status === 'Potential Match' ? 'High' : 'Low'))}">
          ${escapeHtml(result.status || 'Clear')}
        </span>
        <strong>${primary ? escapeHtml(primary.name) : 'No matched entity'}</strong>
      </div>
      <dl>
        <div><dt>Match Type</dt><dd>${primary ? escapeHtml(primary.type) : 'None'}</dd></div>
        <div><dt>Country</dt><dd>${primary ? escapeHtml(primary.country || 'Unknown') : 'Not applicable'}</dd></div>
        <div><dt>Risk Level</dt><dd>${primary ? escapeHtml(primary.risk) : 'Low'}</dd></div>
        <div><dt>Match Confidence</dt><dd>${escapeHtml(result.highestScore || primary?.score || 0)}</dd></div>
        <div><dt>Matched Field</dt><dd>${primary ? escapeHtml(primary.field || 'Name') : 'None'}</dd></div>
        <div><dt>Watchlist Type</dt><dd>${primary ? escapeHtml(primary.type) : 'None'}</dd></div>
      </dl>
      <p><strong>Recommended next step:</strong> ${primary ? 'Review the matched entity and supporting context before proceeding.' : 'Proceed with standard monitoring.'}</p>
    </article>
    ${matches.length > 1 ? `
      <div class="screening-match-list">
        ${matches.slice(1).map((match) => `
          <article>
            <strong>${escapeHtml(match.name)}</strong>
            <span>${escapeHtml(match.type)} · ${escapeHtml(match.field)} · confidence ${escapeHtml(match.score)}</span>
          </article>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function formToJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Fills the live transaction feed table in views/dashboard.ejs with the newest screened transactions.
// shows latest 35 transactions that match the selected risk and company filters, sorted by createdAt desc.
function renderTransactions() {
  if (!elements.transactionRows) return;
  const rows = getFilteredTransactions()
    .filter((txn) => state.riskFilter === 'All' || txn.riskBand === state.riskFilter)
    .filter((txn) => state.transactionStatusFilter === 'All' || txn.status === state.transactionStatusFilter)
    .slice(0, 15)
    .map((txn) => `
      <tr class="transaction-row" data-transaction-id="${escapeHtml(txn.id)}">
        <td>${time.format(new Date(txn.createdAt))}</td>
        <td>
          <strong>${escapeHtml(displayCustomerName(txn))}</strong>
          <div class="muted">${escapeHtml(txn.customerId)}</div>
        </td>
        <td><strong>${escapeHtml(txn.companyName || 'Company')}</strong><div class="muted">${escapeHtml(txn.merchantType || txn.merchantCategory)}</div></td>
        <td>${money.format(txn.amount)}</td>
        <td>${escapeHtml(txn.country)}</td>
        <td>${escapeHtml(txn.channel)}</td>
        <td>${renderWeightedRisk(txn.initialRiskLevel || txn.riskBand, txn.initialRiskScore ?? txn.riskScore)}</td>
        <td>
          <span class="status-chip status-${statusClass(txn.status)}">${escapeHtml(txn.status)}</span>
          ${txn.status === 'Flagged' && (txn.initialRiskLevel || txn.riskBand) === 'Low'
            ? '<div class="muted flagged-low-note">Rule-triggered flag despite low score.</div>'
            : ''}
        </td>
        <td class="transaction-actions">
          ${txn.status === 'Flagged'
        ? `<button type="button" class="secondary-btn review-btn" data-review-transaction-id="${escapeHtml(txn.id)}">Review</button>`
        : '<span class="muted">No action</span>'}
        </td>
      </tr>
    `)
    .join('');

  elements.transactionRows.innerHTML = rows || '<tr><td colspan="9">No transactions found.</td></tr>';
}

// Shows the alert queue in views/investigations.ejs, including the rules that caused each alert.
function renderAlerts() {
  if (!elements.alertList) return;
  const alerts = getFilteredInvestigationAlerts().slice(0, 40);
  elements.alertList.innerHTML = alerts.length ? `
    <div class="table-wrap investigation-table-wrap">
      <table class="investigation-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Triggered Rules</th>
            <th>Risk</th>
            <th>Transactions</th>
            <th>Status</th>
            <th>Assigned</th>
            <th>Latest Activity</th>
            <th>Update</th>
            <th>View</th>
          </tr>
        </thead>
        <tbody>
          ${alerts.map((alert) => `
            <tr>
              <td>
                <strong>${escapeHtml(displayCustomerName(alert))}</strong>
                <div class="muted">${escapeHtml(alert.id)}</div>
              </td>
              <td>${renderRuleSummary(alert.rules || [])}</td>
              <td>${renderWeightedRisk(alert.severity || alert.riskLevel, alert.riskScore)}</td>
              <td>${escapeHtml(alert.groupedCount || (alert.transactionIds || []).length || 1)}</td>
              <td><span class="status-chip status-${statusClass(alert.status)}">${escapeHtml(alert.status)}</span></td>
              <td>${escapeHtml(alert.analyst || 'Unassigned')}</td>
              <td>${time.format(new Date(alert.updatedAt || alert.createdAt))}</td>
              <td>${renderStatusSelect('alert', alert.id, alert.status)}</td>
              <td><button type="button" class="secondary-btn review-btn" data-review-transaction-id="${escapeHtml(alert.transactionId)}">View</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="empty-state">No alerts match the selected filters.</p>';
}

function renderCases() {
  if (!elements.caseList) return;
  const caseRows = getFilteredInvestigationCases().slice(0, 40);
  elements.caseList.innerHTML = caseRows.length ? `
    <div class="table-wrap investigation-table-wrap">
      <table class="investigation-table">
        <thead>
          <tr>
            <th>Case ID</th>
            <th>Customer</th>
            <th>Amount</th>
            <th>Direction</th>
            <th>Risk</th>
            <th>Status</th>
            <th>Assigned</th>
            <th>Due Date</th>
            <th>Update</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          ${caseRows.map((item) => {
            const { amount, direction, alert } = getCaseAmountAndDirection(item);
            return `
              <tr>
                <td><strong>${escapeHtml(item.id)}</strong><div class="muted">${escapeHtml(item.alertId)}</div></td>
                <td>${escapeHtml(displayCustomerName(item))}</td>
                <td>${amount === null ? 'Not available' : money.format(amount)}</td>
                <td>${escapeHtml(direction)}</td>
                <td>${renderWeightedRisk(item.priority, alert?.riskScore)}</td>
                <td><span class="status-chip status-${statusClass(item.status)}">${escapeHtml(item.status)}</span></td>
                <td>${escapeHtml(item.owner || 'Operations Team')}</td>
                <td>${new Date(item.dueAt).toLocaleDateString('en-SG')}</td>
                <td>${renderStatusSelect('case', item.id, item.status)}</td>
                <td><button type="button" class="secondary-btn review-btn" data-review-transaction-id="${escapeHtml(alert?.transactionId || '')}" ${alert?.transactionId ? '' : 'disabled'}>Open Case</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="empty-state">No cases match the selected filters.</p>';
}

function renderStatusSelect(type, id, currentStatus) {
  const attr = type === 'alert' ? 'data-alert-status-id' : 'data-case-status-id';
  return `
    <select class="status-control" ${attr}="${escapeHtml(id)}" aria-label="Update ${type} status">
      ${workflowStatuses.map((status) => `
        <option value="${escapeHtml(status)}" ${status === currentStatus ? 'selected' : ''}>${escapeHtml(status)}</option>
      `).join('')}
    </select>
  `;
}

function renderRuleSummary(rules) {
  const names = rules.slice(0, 2).map((rule) => rule.name).filter(Boolean);
  const more = Math.max(rules.length - names.length, 0);
  return `
    <div class="rule-summary-inline">
      <strong>${escapeHtml(names.join(', ') || 'Screening or profile match')}</strong>
      ${more ? `<span>+${more} more</span>` : ''}
    </div>
  `;
}

function renderWeightedRisk(level, score) {
  return `
    <span class="risk-stack risk-${statusClass(level)}">
      <strong>${escapeHtml(level || 'Low')}</strong>
      <small>Weighted score: ${escapeHtml(score ?? 'N/A')}</small>
    </span>
  `;
}

// Shows critical flagged transactions that need officer attention first.
// shows oldest one first, and only transactions that are still flagged 
function renderOperationsQueue() {
  if (!elements.operationsQueue) return;
  renderInvestigationSummary();
  const isInvestigationsPage = Boolean(elements.investigationStatusFilter);
  const queueLimit = isInvestigationsPage ? 25 : 10;
  const queue = getFilteredTransactions()
    .filter((txn) => txn.status === 'Flagged')
    .filter((txn) => matchesInvestigationRisk(txn.riskBand))
    .filter((txn) => withinDateRange(txn.createdAt, state.investigationDateFilter))
    .map((txn) => {
      const alert = state.alerts.find((item) => item.transactionId === txn.id || (item.transactionIds || []).includes(txn.id));
      const complianceCase = alert ? getCaseByAlertId(alert.id) : null;
      return {
        transaction: txn,
        alert,
        case: complianceCase,
        assessmentStatus: complianceCase?.status || alert?.status || 'New',
        assigned: complianceCase?.owner || alert?.analyst || 'Unassigned',
        dueAt: complianceCase?.dueAt || null,
      };
    })
    .filter((item) => investigationTextMatches([
      item.transaction.customerName,
      item.transaction.customerId,
      item.transaction.id,
      item.alert?.id,
      item.case?.id,
    ]))
    .filter((item) => matchesInvestigationStatus(item.assessmentStatus))
    .filter((item) => matchesInvestigationAnalyst(item.assigned))
    .sort((left, right) => {
      const riskOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      return (riskOrder[left.transaction.riskBand] ?? 9) - (riskOrder[right.transaction.riskBand] ?? 9)
        || new Date(left.transaction.createdAt) - new Date(right.transaction.createdAt);
    })
    .slice(0, queueLimit);

  elements.operationsQueue.innerHTML = queue.length
    ? `
      <div class="table-wrap operations-table-wrap">
        <table class="queue-table">
          <thead>
            <tr>
              <th>Date / Time</th>
              <th>Customer</th>
              <th>Company</th>
              <th>Amount</th>
              <th>Country</th>
              <th>Initial Risk</th>
              <th>Assessment Status</th>
              <th>Assigned Analyst</th>
              <th>Due Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${queue.map(({ transaction: txn, assessmentStatus, assigned, dueAt }) => `
              <tr class="transaction-row" data-queue-transaction-id="${escapeHtml(txn.id)}">
                <td>${new Date(txn.createdAt).toLocaleString('en-SG')}</td>
                <td>
                  <strong>${escapeHtml(displayCustomerName(txn))}</strong>
                  <div class="muted">${escapeHtml(txn.customerId)}</div>
                </td>
                <td>
                  <strong>${escapeHtml(txn.companyName || 'Company')}</strong>
                  <div class="muted">${escapeHtml(txn.merchantType || txn.merchantCategory)}</div>
                </td>
                <td>${money.format(txn.amount)}</td>
                <td>${escapeHtml(txn.country)}</td>
                <td>${renderWeightedRisk(txn.initialRiskLevel || txn.riskBand, txn.initialRiskScore ?? txn.riskScore)}</td>
                <td><span class="status-chip status-${statusClass(assessmentStatus)}">${escapeHtml(assessmentStatus)}</span></td>
                <td>${escapeHtml(assigned)}</td>
                <td>${dueAt ? new Date(dueAt).toLocaleDateString('en-SG') : 'Not assigned'}</td>
                <td class="transaction-actions queue-actions">
                  <button type="button" class="secondary-btn review-btn queue-review-btn" data-review-transaction-id="${escapeHtml(txn.id)}">Review</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
    : '<p class="empty-state">No alerts match the selected filters.</p>';
}

function renderInvestigationSummary() {
  const items = getWorkflowItemsForSummary();
  const today = new Date().toLocaleDateString('en-SG');
  const counts = {
    New: 0,
    'Under Review': 0,
    'Waiting for Information': 0,
    Escalated: 0,
    overdue: 0,
    resolvedToday: 0,
  };
  items.forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
    if (item.dueAt && new Date(item.dueAt).getTime() < Date.now() && !['Resolved', 'False Positive'].includes(item.status)) {
      counts.overdue += 1;
    }
    if (item.status === 'Resolved' && item.updatedAt && new Date(item.updatedAt).toLocaleDateString('en-SG') === today) {
      counts.resolvedToday += 1;
    }
  });

  if (elements.investigationSummaryNew) elements.investigationSummaryNew.textContent = counts.New;
  if (elements.investigationSummaryUnderReview) elements.investigationSummaryUnderReview.textContent = counts['Under Review'];
  if (elements.investigationSummaryWaiting) elements.investigationSummaryWaiting.textContent = counts['Waiting for Information'];
  if (elements.investigationSummaryEscalated) elements.investigationSummaryEscalated.textContent = counts.Escalated;
  if (elements.investigationSummaryOverdue) elements.investigationSummaryOverdue.textContent = counts.overdue;
  if (elements.investigationSummaryResolvedToday) elements.investigationSummaryResolvedToday.textContent = counts.resolvedToday;
}

function renderAuditLogs() {
  if (!elements.auditList) return;
  const grouped = groupAuditLogsForDisplay(getFilteredAuditLogs());
  const visible = grouped.slice(0, state.auditVisibleCount);
  elements.auditList.innerHTML = visible.map((entry) => `
    <article class="audit-item">
      <div class="audit-dot"></div>
      <div>
        <div class="audit-top">
          <strong>${escapeHtml(entry.action)}${entry.count > 1 ? ` x ${entry.count}` : ''}</strong>
          <span>${time.format(new Date(entry.createdAt))}</span>
        </div>
        <p>${escapeHtml(entry.message || '')}</p>
        <div class="meta">Actor: ${escapeHtml(entry.actor)} &middot; Entity: ${escapeHtml(entry.entityType)}${entry.entityId ? ` &middot; ${escapeHtml(entry.entityId)}` : ''}</div>
      </div>
    </article>
  `).join('') || '<p class="empty-state">No audit records match the selected filters.</p>';

  if (elements.auditViewMore) elements.auditViewMore.classList.toggle('is-hidden', grouped.length <= state.auditVisibleCount);
  if (elements.auditViewAll) elements.auditViewAll.classList.toggle('is-hidden', grouped.length <= state.auditVisibleCount);
}

function groupAuditLogsForDisplay(entries) {
  const sorted = [...entries].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const grouped = [];
  sorted.forEach((entry) => {
    const previous = grouped[grouped.length - 1];
    const sameShortWindow = previous
      && previous.action === entry.action
      && previous.actor === entry.actor
      && previous.entityType === entry.entityType
      && Math.abs(new Date(previous.createdAt) - new Date(entry.createdAt)) <= 2 * 60 * 1000;
    if (sameShortWindow && entry.action === 'Alert Grouped') {
      previous.count += 1;
      return;
    }
    grouped.push({ ...entry, count: 1 });
  });
  return grouped;
}

// Displays each company's transaction monitoring rules on views/rules.ejs.
function renderRules() {
  if (!elements.companyRuleTabs || !elements.companyRuleDetail) return;
  const ruleSets = state.ruleSets || [];
  if (!ruleSets.length) {
    elements.companyRuleDetail.innerHTML = '<p class="muted">No company rules available.</p>';
    return;
  }

  const selectedId = elements.companyRuleTabs.dataset.selectedCompany || ruleSets[0].id;
  const selected = ruleSets.find((company) => company.id === selectedId) || ruleSets[0];
  elements.companyRuleTabs.dataset.selectedCompany = selected.id;

  elements.companyRuleTabs.innerHTML = ruleSets.map((company) => {
    const highCount = company.rules.filter((rule) => rule.risk === 'High').length;
    const mediumCount = company.rules.filter((rule) => rule.risk === 'Medium').length;
    return `
      <button type="button" class="rule-tab-card ${company.id === selected.id ? 'active' : ''}" data-company-id="${escapeHtml(company.id)}">
        <span class="company-label">${escapeHtml(company.name)}</span>
        <strong>${escapeHtml(company.merchantType)}</strong>
        <span class="company-rule-meta">${mediumCount} medium · ${highCount} high · ${company.rules.length} total rules</span>
      </button>
    `;
  }).join('');

  elements.companyRuleDetail.innerHTML = `
    <section class="company-rules-heading">
      <div>
        <span>${escapeHtml(selected.merchantType)}</span>
        <h2>${escapeHtml(selected.name)} rules</h2>
      </div>
      <div class="company-view-pill">Viewing ${escapeHtml(selected.name)}</div>
    </section>

    <section class="company-rule-cards">
      ${selected.cards.map((card) => `
        <article class="rule-summary-card tone-${escapeHtml(card.tone)}">
          <h3>${escapeHtml(card.title)}</h3>
          <p>${escapeHtml(card.text)}</p>
        </article>
      `).join('')}
    </section>

    <section class="panel rules-table-panel">
      <div class="table-wrap">
        <table class="rules-table">
          <thead>
            <tr>
              <th>Rule ID</th>
              <th>Rule</th>
              <th>Risk</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            ${selected.rules.map((rule) => `
              <tr>
                <td>${escapeHtml(rule.id)}</td>
                <td>${escapeHtml(rule.name)}</td>
                <td>${escapeHtml(rule.risk)}</td>
                <td>${escapeHtml(rule.reason)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}


function getTransactionDetailModal() {
  let modal = document.querySelector('#transactionDetailModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'transactionDetailModal';
  modal.className = 'detail-modal';
  modal.innerHTML = `
    <div class="detail-modal-backdrop" data-close-transaction-modal></div>
    <section class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="transactionDetailTitle">
      <button type="button" class="detail-close" data-close-transaction-modal aria-label="Close transaction details">Close</button>
      <div id="transactionDetailContent"></div>
    </section>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-transaction-modal]')) closeTransactionDetails();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTransactionDetails();
  });
  return modal;
}

function openTransactionDetails(transactionId) {
  window.location.assign(`/transactions/${encodeURIComponent(transactionId)}`);
}

function closeTransactionDetails() {
  const modal = document.querySelector('#transactionDetailModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.classList.remove('modal-open');
}

let activeTransactionAction = null;

// Updates the transaction review page with the selected transaction's status and action buttons.
function renderTransactionDetailPage() {
  if (!elements.transactionDetailPage) return;

  const transaction = getTransactionById(state.detailTransactionId);
  if (!transaction) return;

  const current = transaction;
  const assessmentResolved = isAssessmentResolved(current);
  const assessmentStatus = getAssessmentStatus(current);
  if (elements.transactionDetailStatus) {
    elements.transactionDetailStatus.className = `badge transaction-status-badge status-${statusClass(current.status)}`;
    elements.transactionDetailStatus.textContent = current.status;
  }
  if (elements.assessmentStatusBadge) {
    elements.assessmentStatusBadge.className = `badge transaction-status-badge status-${statusClass(assessmentStatus)}`;
    elements.assessmentStatusBadge.textContent = assessmentStatus;
  }
  if (elements.assessmentDecisionBadge) {
    elements.assessmentDecisionBadge.textContent = current.decision || 'Not assigned';
  }

  if (elements.transactionDetailConfirmation) {
    const actionLabel = current.actionLabel || current.reviewAction || null;
    elements.transactionDetailConfirmation.textContent = assessmentResolved
      ? 'Assessment resolved.'
      : assessmentStatus === 'Escalated'
        ? 'This case has been escalated for senior review.'
        : isFinalTransactionStatus(current.status)
      ? `${actionLabel ? `${actionLabel} completed. ` : ''}No further action is needed for this transaction.`
      : 'Choose an action to continue the review workflow.';
  }

  const buttonContainer = elements.transactionDetailActionButtons;
  if (buttonContainer) {
    const completed = assessmentResolved || isFinalTransactionStatus(current.status);
    buttonContainer.querySelectorAll('[data-transaction-action]').forEach((button) => {
      button.disabled = completed || (assessmentStatus === 'Escalated' && button.dataset.transactionAction === 'escalate');
    });
  }
  if (elements.investigationActionsSection) elements.investigationActionsSection.classList.toggle('is-hidden', assessmentResolved);
  if (elements.resolveAssessmentSection) elements.resolveAssessmentSection.classList.toggle('is-hidden', assessmentResolved);
  if (elements.escalatedAssessmentMessage) elements.escalatedAssessmentMessage.classList.toggle('is-hidden', assessmentStatus !== 'Escalated');
  if (elements.assessmentOutcomeSection) elements.assessmentOutcomeSection.classList.toggle('is-hidden', !assessmentResolved);

  if (elements.transactionActionTitle && activeTransactionAction) {
    const actionLabel = activeTransactionAction === 'rfi'
      ? 'Request for Information'
      : activeTransactionAction === 'str'
        ? 'File STR'
        : 'Review action';
    elements.transactionActionTitle.textContent = actionLabel;
  }

  if (elements.transactionActionForm && elements.transactionActionType) {
    elements.transactionActionType.value = activeTransactionAction || '';
  }
}

function populateTransactionActionForm(transaction, action) {
  if (!elements.transactionActionForm) return;

  if (elements.transactionActionName) elements.transactionActionName.value = transaction.customerName || '';
  if (elements.transactionActionAmount) elements.transactionActionAmount.value = money.format(transaction.amount || 0);
  if (elements.transactionActionCountry) elements.transactionActionCountry.value = transaction.country || '';
  if (elements.transactionActionCategory) elements.transactionActionCategory.value = transaction.merchantCategory || transaction.merchantType || '';
  if (elements.transactionActionType) elements.transactionActionType.value = action;
  if (elements.transactionActionSubmit) {
    elements.transactionActionSubmit.textContent = action === 'rfi' ? 'Submit RFI' : 'Submit STR';
  }
}

// Opens the review action form when the officer chooses RFI, STR, dismiss, or escalate.
// For RFI and STR, the form is pre-filled with transaction details to save time for the officer.
function openTransactionActionForm(action) {
  const transaction = getTransactionById(state.detailTransactionId);
  if (!transaction) return;
  const current = transaction;
  if (isAssessmentResolved(current) || isFinalTransactionStatus(current.status)) return;

  activeTransactionAction = action;
  //auto filled
  populateTransactionActionForm(transaction, action);
  if (elements.transactionActionModal) {
    elements.transactionActionModal.classList.add('open');
    document.body.classList.add('modal-open');
  }
  renderTransactionDetailPage();
}

function closeTransactionActionForm() {
  activeTransactionAction = null;
  if (elements.transactionActionModal) {
    elements.transactionActionModal.classList.remove('open');
  }
  document.body.classList.remove('modal-open');
  renderTransactionDetailPage();
}

function updateTransactionDetailActionFeedback(message) {
  if (!elements.transactionDetailConfirmation) return;
  elements.transactionDetailConfirmation.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function updateAlertStatus(alertId, status) {
  await fetch(`/api/alerts/${encodeURIComponent(alertId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, analyst: 'Operations Team' }),
  });
}

async function updateCaseStatus(caseId, status) {
  await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, owner: 'Operations Team' }),
  });
}

async function resolveAssessment(transactionId, payload) {
  const url = `/api/transactions/${encodeURIComponent(transactionId)}/resolve`;
  // Temporary debug logging for the resolve request. Notes are logged by length only.
  console.log('Resolve Assessment submit', {
    transactionId,
    url,
    body: {
      finalRiskLevel: payload.finalRiskLevel,
      decision: payload.decision,
      resolutionReason: payload.resolutionReason,
      analystNotesLength: String(payload.analystNotes || '').length,
    },
  });

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const responseText = await response.text();
    throw new Error(`Server returned ${response.status} instead of JSON: ${responseText.slice(0, 200)}`);
  }

  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || 'Unable to resolve assessment');
  return body;
}

async function submitTransactionAction(transactionId, payload) {
  const response = await fetch(`/api/transactions/${encodeURIComponent(transactionId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const responseText = await response.text();
    throw new Error(`Server returned ${response.status} instead of JSON: ${responseText.slice(0, 200)}`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'Unable to save action');
  return body;
}

async function submitRfiEmail(transactionId, payload) {
  const response = await fetch(`/api/transactions/${encodeURIComponent(transactionId)}/rfi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const responseText = await response.text();
    throw new Error(`Server returned ${response.status} instead of JSON: ${responseText.slice(0, 200)}`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'Unable to send RFI email');
  return body;
}

async function loadRfiEmailConfig() {
  if (!elements.rfiEmailForm) return;
  try {
    const response = await fetch('/api/rfi/config');
    if (!response.ok) return;
    state.rfiEmailConfig = await response.json();
  } catch (error) {
    state.rfiEmailConfig = { ...state.rfiEmailConfig };
  }
}

function buildRfiPreview(transaction, payload) {
  const recipientName = getRfiRecipient(transaction).name;
  return [
    `Dear ${recipientName},`,
    '',
    'We require additional information to complete our routine review of a recent transaction.',
    '',
    'Please provide the following information or supporting documents:',
    '',
    payload.informationRequested.trim(),
    '',
    `Transaction reference: ${transaction.id}`,
    `Transaction date: ${new Date(transaction.createdAt).toLocaleString('en-SG')}`,
    `Transaction amount: ${formatRfiAmount(transaction)}`,
    '',
    'Please reply to this email with the requested information.',
    '',
    'Thank you.',
    '',
    'Customer Review Team',
    transaction.companyName,
  ].filter((line) => line !== null).join('\n');
}

function getRfiPreviewSubject(payload) {
  const subject = String(payload.subject || '').trim();
  return state.rfiEmailConfig.testMode || state.rfiEmailConfig.etherealMode ? `[TEST] ${subject}` : subject;
}

function validateRfiPayload(payload) {
  if (!String(payload.subject || '').trim()) return 'Subject is required.';
  if (!hasMeaningfulAnalystNotes(payload.informationRequested)) {
    return 'Please provide a meaningful information request of at least 10 characters.';
  }
  const transaction = getTransactionById(state.detailTransactionId);
  const recipient = transaction ? getRfiRecipient(transaction) : null;
  if (findRfiRestrictedPhrase(payload.subject, payload.informationRequested)) {
    return 'This message may disclose internal compliance information. Please use neutral verification wording.';
  }
  return null;
}

function getRfiPayload() {
  const formData = new FormData(elements.rfiEmailForm);
  return {
    subject: String(formData.get('subject') || '').trim(),
    informationRequested: String(formData.get('informationRequested') || '').trim(),
  };
}

function getRfiRecipient(transaction) {
  const accountType = transaction.accountType || 'Individual';
  const savedEmail = accountType === 'Organisation'
    ? transaction.authorisedContactEmail
    : transaction.customerEmail;
  const name = accountType === 'Organisation'
    ? (transaction.authorisedContactName || transaction.customerName || 'Authorised Contact')
    : (transaction.customerName || 'Customer');
  return {
    accountType,
    name,
    accountName: transaction.customerName || '',
    savedEmail: savedEmail || '',
    hasSavedEmail: Boolean(savedEmail),
    emailLabel: savedEmail
      ? (accountType === 'Organisation' ? 'Authorised contact email' : 'Customer email')
      : 'Temporary recipient email',
  };
}

function openRfiEmailModal() {
  const transaction = getTransactionById(state.detailTransactionId);
  if (!transaction || isAssessmentResolved(transaction)) return;
  const recipient = getRfiRecipient(transaction);
  if (elements.rfiRecipientType) elements.rfiRecipientType.value = recipient.accountType;
  if (elements.rfiRecipientName) elements.rfiRecipientName.value = recipient.accountType === 'Organisation'
    ? `${recipient.accountName} / ${recipient.name}`
    : recipient.name;
  if (elements.rfiRecipientEmailLabel) elements.rfiRecipientEmailLabel.textContent = recipient.emailLabel;
  if (elements.rfiRecipientEmail) {
    elements.rfiRecipientEmail.value = recipient.savedEmail;
    elements.rfiRecipientEmail.readOnly = true;
    elements.rfiRecipientEmail.required = false;
  }
  if (elements.rfiRecipientEmailHelp) {
    elements.rfiRecipientEmailHelp.textContent = recipient.hasSavedEmail
      ? 'Saved customer contact. In Ethereal test mode, the email is captured in a preview inbox and is not delivered to this address.'
      : 'No saved customer contact is available. Add a saved customer or authorised contact email before sending an RFI.';
  }
  if (elements.rfiTestModeNotice) {
    const developmentMode = state.rfiEmailConfig.testMode || state.rfiEmailConfig.etherealMode;
    elements.rfiTestModeNotice.classList.toggle('is-hidden', !developmentMode);
    elements.rfiTestModeNotice.textContent = state.rfiEmailConfig.etherealMode
      ? 'Development mode: Email will be captured by Ethereal and will not be delivered to the real customer.'
      : 'Test mode is enabled. The saved customer email remains read-only.';
  }
  if (elements.rfiEmailFeedback) elements.rfiEmailFeedback.textContent = '';
  if (elements.rfiEmailPreview) {
    elements.rfiEmailPreview.classList.add('is-hidden');
    elements.rfiEmailPreview.innerHTML = '';
  }
  if (elements.rfiEmailModal) {
    elements.rfiEmailModal.classList.add('open');
    document.body.classList.add('modal-open');
  }
}

function closeRfiEmailModal() {
  if (elements.rfiEmailModal) elements.rfiEmailModal.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function ensureTransactionActivityLogContainer() {
  if (elements.transactionActivityLog) return elements.transactionActivityLog;
  if (!elements.transactionDetailPage) return null;
  const modal = document.querySelector('#transactionActionModal');
  const section = document.createElement('section');
  section.className = 'panel detail-section';
  section.innerHTML = `
    <div class="panel-header">
      <div>
        <h2>Activity Log</h2>
        <p>Timeline for this transaction only.</p>
      </div>
    </div>
    <div id="transactionActivityLog" class="transaction-activity-list"></div>
  `;
  elements.transactionDetailPage.insertBefore(section, modal || null);
  elements.transactionActivityLog = section.querySelector('#transactionActivityLog');
  return elements.transactionActivityLog;
}

function renderTransactionActivityLogs(activityLogs = []) {
  const container = activityLogs.length ? ensureTransactionActivityLogContainer() : elements.transactionActivityLog;
  if (!container) return;
  container.innerHTML = activityLogs.map((entry) => `
    <article class="transaction-activity-item">
      <time>${time.format(new Date(entry.createdAt))}</time>
      <div>
        <strong>${escapeHtml(entry.action)}</strong>
        <p>${escapeHtml(entry.message || '')}</p>
        <span>${escapeHtml(entry.actor || 'System')} &middot; ${new Date(entry.createdAt).toLocaleString('en-SG')}</span>
      </div>
    </article>
  `).join('');
}

function updateAssessmentResult(transaction) {
  const resolvedAt = transaction.resolvedAt ? new Date(transaction.resolvedAt).toLocaleString('en-SG') : 'Not assigned';
  if (elements.assessmentFinalRiskScoreSummary) elements.assessmentFinalRiskScoreSummary.textContent = transaction.finalRiskScore ?? 'Not assigned';
  if (elements.assessmentFinalRiskLevelSummary) elements.assessmentFinalRiskLevelSummary.textContent = transaction.finalRiskLevel || 'Not assigned';
  if (elements.assessmentFinalRiskScore) elements.assessmentFinalRiskScore.textContent = transaction.finalRiskScore ?? 'Not assigned';
  if (elements.assessmentFinalRiskLevel) elements.assessmentFinalRiskLevel.textContent = transaction.finalRiskLevel || 'Not assigned';
  if (elements.assessmentDecision) elements.assessmentDecision.textContent = transaction.decision || 'Not assigned';
  if (elements.assessmentDecisionDetail) elements.assessmentDecisionDetail.textContent = transaction.decision || 'Not assigned';
  if (elements.assessmentResolutionReason) elements.assessmentResolutionReason.textContent = transaction.resolutionReason || 'Not assigned';
  if (elements.assessmentResolutionReasonDetail) elements.assessmentResolutionReasonDetail.textContent = transaction.resolutionReason || 'Not assigned';
  if (elements.assessmentAnalystNotes) elements.assessmentAnalystNotes.textContent = transaction.analystNotes || 'Not assigned';
  if (elements.assessmentResolvedAt) elements.assessmentResolvedAt.textContent = resolvedAt;
  if (elements.assessmentResolvedAtDetail) elements.assessmentResolvedAtDetail.textContent = resolvedAt;
  if (elements.assessmentStatusBadge) {
    elements.assessmentStatusBadge.className = 'badge transaction-status-badge status-resolved';
    elements.assessmentStatusBadge.textContent = 'Resolved';
  }
  if (elements.assessmentDecisionBadge) elements.assessmentDecisionBadge.textContent = transaction.decision || 'Not assigned';
  if (elements.transactionDetailConfirmation) elements.transactionDetailConfirmation.textContent = 'Assessment resolved.';
  if (elements.investigationActionsSection) elements.investigationActionsSection.classList.add('is-hidden');
  if (elements.resolveAssessmentSection) elements.resolveAssessmentSection.classList.add('is-hidden');
  if (elements.escalatedAssessmentMessage) elements.escalatedAssessmentMessage.classList.add('is-hidden');
  if (elements.assessmentOutcomeSection) elements.assessmentOutcomeSection.classList.remove('is-hidden');
}

async function refreshCustomerRisk() {
  if (!elements.customerRiskRows) return;
  const response = await fetch('/api/customers/risk');
  state.customerRiskProfiles = await response.json();
  renderCustomerRisk();
}



if (elements.companyFilter) {
  elements.companyFilter.addEventListener('change', (event) => {
    state.companyFilter = event.target.value;
    render();
  });
}
if (elements.kycStatusFilter) {
  elements.kycStatusFilter.addEventListener('change', (event) => {
    state.kycStatusFilter = event.target.value;
    renderCustomerRisk();
  });
}
if (elements.screeningStatusFilter) {
  elements.screeningStatusFilter.addEventListener('change', (event) => {
    state.screeningStatusFilter = event.target.value;
    renderCustomerRisk();
  });
}
if (elements.customerRiskLevelFilter) {
  elements.customerRiskLevelFilter.addEventListener('change', (event) => {
    state.customerRiskLevelFilter = event.target.value;
    renderCustomerRisk();
  });
}
function rerenderInvestigations() {
  renderOperationsQueue();
  renderAlerts();
  renderCases();
}

if (elements.investigationStatusFilter) {
  elements.investigationStatusFilter.addEventListener('change', (event) => {
    state.investigationStatusFilter = event.target.value;
    rerenderInvestigations();
  });
}
if (elements.investigationRiskFilter) {
  elements.investigationRiskFilter.addEventListener('change', (event) => {
    state.investigationRiskFilter = event.target.value;
    rerenderInvestigations();
  });
}
if (elements.investigationAnalystFilter) {
  elements.investigationAnalystFilter.addEventListener('change', (event) => {
    state.investigationAnalystFilter = event.target.value;
    rerenderInvestigations();
  });
}
if (elements.investigationDateFilter) {
  elements.investigationDateFilter.addEventListener('change', (event) => {
    state.investigationDateFilter = event.target.value;
    rerenderInvestigations();
  });
}
if (elements.investigationSearchInput) {
  elements.investigationSearchInput.addEventListener('input', (event) => {
    state.investigationSearchQuery = event.target.value;
    rerenderInvestigations();
  });
}
if (elements.auditActionFilter) {
  elements.auditActionFilter.addEventListener('change', (event) => {
    state.auditActionFilter = event.target.value;
    state.auditVisibleCount = 20;
    renderAuditLogs();
  });
}
if (elements.auditActorFilter) {
  elements.auditActorFilter.addEventListener('change', (event) => {
    state.auditActorFilter = event.target.value;
    state.auditVisibleCount = 20;
    renderAuditLogs();
  });
}
if (elements.auditViewMore) {
  elements.auditViewMore.addEventListener('click', () => {
    state.auditVisibleCount += 20;
    renderAuditLogs();
  });
}
if (elements.auditViewAll) {
  elements.auditViewAll.addEventListener('click', () => {
    state.auditVisibleCount = Number.MAX_SAFE_INTEGER;
    renderAuditLogs();
  });
}
if (elements.analyticsPeriodFilter) {
  elements.analyticsPeriodFilter.addEventListener('change', (event) => {
    state.analyticsPeriodFilter = event.target.value;
    renderCharts();
    renderAnalytics();
  });
}
if (elements.analyticsRiskFilter) {
  elements.analyticsRiskFilter.addEventListener('change', (event) => {
    state.analyticsRiskFilter = event.target.value;
    renderCharts();
    renderAnalytics();
  });
}
if (elements.analyticsStatusFilter) {
  elements.analyticsStatusFilter.addEventListener('change', (event) => {
    state.analyticsStatusFilter = event.target.value;
    renderCharts();
    renderAnalytics();
  });
}
if (elements.companyExposureSort) {
  elements.companyExposureSort.addEventListener('change', (event) => {
    state.companyExposureSort = event.target.value;
    renderAnalytics();
  });
}
if (elements.customerWatchlistToggle) {
  elements.customerWatchlistToggle.addEventListener('click', () => {
    state.showAllAnalyticsCustomers = !state.showAllAnalyticsCustomers;
    renderAnalytics();
  });
}
if (elements.companyRuleTabs) {
  elements.companyRuleTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-company-id]');
    if (!tab) return;
    elements.companyRuleTabs.dataset.selectedCompany = tab.dataset.companyId;
    renderRules();
  });
}
if (elements.transactionRows) {
  elements.transactionRows.addEventListener('click', (event) => {
    const reviewButton = event.target.closest('[data-review-transaction-id]');
    if (!reviewButton) return;
    openTransactionDetails(reviewButton.dataset.reviewTransactionId);
  });
}
if (elements.operationsQueue) {
  elements.operationsQueue.addEventListener('click', (event) => {
    const reviewButton = event.target.closest('[data-review-transaction-id]');
    if (!reviewButton) return;
    openTransactionDetails(reviewButton.dataset.reviewTransactionId);
  });
}
if (elements.riskFilter) {
  elements.riskFilter.addEventListener('change', (event) => {
    state.riskFilter = event.target.value;
    renderTransactions();
  });
}
if (elements.transactionStatusFilter) {
  elements.transactionStatusFilter.addEventListener('change', (event) => {
    state.transactionStatusFilter = event.target.value;
    renderTransactions();
  });
}

if (elements.transactionDetailActionButtons) {
  elements.transactionDetailActionButtons.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-transaction-action]');
    if (!button) return;

    const action = button.dataset.transactionAction;
    if (action === 'rfi') {
      openRfiEmailModal();
      return;
    }

    if (action === 'str') {
      openTransactionActionForm(action);
      return;
    }

    const transaction = getTransactionById(state.detailTransactionId);
    const current = transaction || null;
    if (!current || isAssessmentResolved(current) || isFinalTransactionStatus(current.status)) return;

    if (action === 'escalate') {
      if (getAssessmentStatus(current) === 'Escalated') return;
      button.disabled = true;
      try {
        const result = await submitTransactionAction(transaction.id, {
          actionType: 'CASE_ESCALATED',
          notes: 'Case escalated for senior review.',
        });
        state.transactions = state.transactions.map((item) => (item.id === result.transaction.id ? result.transaction : item));
        if (state.detailSeed?.id === result.transaction.id) state.detailSeed = result.transaction;
        renderTransactionActivityLogs(result.activityLogs || []);
        renderTransactionDetailPage();
      } catch (error) {
        button.disabled = false;
        updateTransactionDetailActionFeedback(error.message);
      }
      return;
    }

    updateTransactionDetailActionFeedback('Unsupported transaction action.');
  });
}

document.querySelectorAll('[data-close-rfi-modal]').forEach((button) => {
  button.addEventListener('click', closeRfiEmailModal);
});

if (elements.rfiPreviewButton) {
  elements.rfiPreviewButton.addEventListener('click', () => {
    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction || !elements.rfiEmailPreview) return;
    const payload = getRfiPayload();
    const validationMessage = validateRfiPayload(payload);
    if (validationMessage) {
      if (elements.rfiEmailFeedback) elements.rfiEmailFeedback.textContent = validationMessage;
      return;
    }
    elements.rfiEmailFeedback.textContent = '';
    elements.rfiEmailPreview.classList.remove('is-hidden');
    const displayedRecipient = getRfiRecipient(transaction).savedEmail || '';
    const previewSubject = getRfiPreviewSubject(payload);
    elements.rfiEmailPreview.innerHTML = `
      <strong>Delivery Mode</strong>
      <div>${state.rfiEmailConfig.etherealMode ? 'Development (Ethereal)' : state.rfiEmailConfig.testMode ? 'Test' : 'Live'}</div>
      <strong>Recipient</strong>
      <div>${escapeHtml(displayedRecipient)}</div>
      <strong>Subject</strong>
      <div>${escapeHtml(previewSubject)}</div>
      <strong>Email Body</strong>
      <pre>${escapeHtml(buildRfiPreview(transaction, payload))}</pre>
    `;
  });
}

if (elements.rfiEmailForm) {
  elements.rfiEmailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;

    const payload = getRfiPayload();
    const validationMessage = validateRfiPayload(payload);
    if (validationMessage) {
      if (elements.rfiEmailFeedback) elements.rfiEmailFeedback.textContent = validationMessage;
      return;
    }

    if (elements.rfiSendButton) {
      elements.rfiSendButton.disabled = true;
      elements.rfiSendButton.textContent = 'Sending...';
    }
    if (elements.rfiEmailFeedback) elements.rfiEmailFeedback.textContent = 'Sending...';

    try {
      const result = await submitRfiEmail(transaction.id, payload);
      state.transactions = state.transactions.map((item) => (item.id === result.transaction.id ? result.transaction : item));
      if (state.detailSeed?.id === result.transaction.id) state.detailSeed = result.transaction;
      renderTransactionActivityLogs(result.activityLogs || []);
      closeRfiEmailModal();
      renderTransactionDetailPage();
      updateTransactionDetailActionFeedback(result.message || 'Request for Information sent successfully.');
      if (result.previewUrl && elements.transactionDetailConfirmation) {
        const link = document.createElement('a');
        link.href = result.previewUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'inline-action-link';
        link.textContent = 'Open Test Email';
        elements.transactionDetailConfirmation.append(' ');
        elements.transactionDetailConfirmation.appendChild(link);
      }
    } catch (error) {
      if (elements.rfiEmailFeedback) elements.rfiEmailFeedback.textContent = error.message;
    } finally {
      if (elements.rfiSendButton) {
        elements.rfiSendButton.disabled = false;
        elements.rfiSendButton.textContent = 'Send RFI';
      }
    }
  });
}

if (elements.transactionActionForm) {
  elements.transactionActionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = elements.transactionActionType?.value || activeTransactionAction;
    if (!action) return;

    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;
    const notes = String(new FormData(elements.transactionActionForm).get('notes') || '').trim();
    if (!hasMeaningfulAnalystNotes(notes)) {
      updateTransactionDetailActionFeedback('Please provide a meaningful explanation of at least 10 characters.');
      return;
    }

    const actionType = action === 'rfi' ? 'RFI_REQUESTED' : action === 'str' ? 'STR_FILED' : null;
    if (!actionType) return;

    const submitButton = elements.transactionActionSubmit;
    if (submitButton) submitButton.disabled = true;
    try {
      const result = await submitTransactionAction(transaction.id, { actionType, notes });
      state.transactions = state.transactions.map((item) => (item.id === result.transaction.id ? result.transaction : item));
      if (state.detailSeed?.id === result.transaction.id) state.detailSeed = result.transaction;
      renderTransactionActivityLogs(result.activityLogs || []);
      closeTransactionActionForm();
      renderTransactionDetailPage();
    } catch (error) {
      if (submitButton) submitButton.disabled = false;
      updateTransactionDetailActionFeedback(error.message);
    }
  });
}

if (elements.resolveAssessmentForm) {
  elements.resolveAssessmentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;

    const submitButton = elements.resolveAssessmentForm.querySelector('button[type="submit"]');
    const payload = formToJson(elements.resolveAssessmentForm);
    if (!hasMeaningfulAnalystNotes(payload.analystNotes)) {
      if (elements.resolveAssessmentFeedback) {
        elements.resolveAssessmentFeedback.textContent = 'Please provide a meaningful explanation of at least 10 characters.';
      }
      return;
    }
    submitButton.disabled = true;
    if (elements.resolveAssessmentFeedback) elements.resolveAssessmentFeedback.textContent = 'Resolving assessment...';

    try {
      const result = await resolveAssessment(transaction.id, payload);
      const resolvedTransaction = result.transaction;
      state.transactions = state.transactions.map((item) => (item.id === resolvedTransaction.id ? resolvedTransaction : item));
      if (state.detailSeed?.id === resolvedTransaction.id) state.detailSeed = resolvedTransaction;
      updateAssessmentResult(resolvedTransaction);
      renderTransactionActivityLogs(result.activityLogs || []);
      if (elements.resolveAssessmentFeedback) elements.resolveAssessmentFeedback.textContent = 'Assessment resolved.';
      elements.resolveAssessmentForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
        control.disabled = true;
      });
    } catch (error) {
      submitButton.disabled = false;
      if (elements.resolveAssessmentFeedback) elements.resolveAssessmentFeedback.textContent = error.message;
    }
  });
}

if (elements.transactionActionModal) {
  elements.transactionActionModal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-transaction-action]')) {
      closeTransactionActionForm();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.transactionActionModal?.classList.contains('open')) {
    closeTransactionActionForm();
  }
});

if (elements.alertList) {
  elements.alertList.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-alert-status-id]');
    if (!select) return;

    select.disabled = true;
    await updateAlertStatus(select.dataset.alertStatusId, select.value);
  });

  elements.alertList.addEventListener('click', (event) => {
    const reviewButton = event.target.closest('[data-review-transaction-id]');
    if (!reviewButton || !reviewButton.dataset.reviewTransactionId) return;
    openTransactionDetails(reviewButton.dataset.reviewTransactionId);
  });
}

if (elements.caseList) {
  elements.caseList.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-case-status-id]');
    if (!select) return;

    select.disabled = true;
    await updateCaseStatus(select.dataset.caseStatusId, select.value);
  });

  elements.caseList.addEventListener('click', (event) => {
    const reviewButton = event.target.closest('[data-review-transaction-id]');
    if (!reviewButton || !reviewButton.dataset.reviewTransactionId) return;
    openTransactionDetails(reviewButton.dataset.reviewTransactionId);
  });
}

if (elements.simulateBtn) {
  elements.simulateBtn.addEventListener('click', async () => {
    elements.simulateBtn.disabled = true;
    if (elements.simulateFeedback) elements.simulateFeedback.textContent = 'Generating demo transaction...';
    try {
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Manual High-Risk Review',
          amount: 52000,
          country: 'Iran',
          merchantCategory: 'Crypto Exchange',
          channel: 'Bank Transfer',
          direction: 'Outbound',
          actor: 'Analyst Ryan',
        }),
      });
      if (!response.ok) throw new Error('Unable to create demo transaction.');
      if (elements.simulateFeedback) elements.simulateFeedback.textContent = 'Demo transaction created.';
    } catch (error) {
      if (elements.simulateFeedback) elements.simulateFeedback.textContent = error.message;
    } finally {
      setTimeout(() => {
        elements.simulateBtn.disabled = false;
      }, 900);
    }
  });
}

if (elements.customerScreeningForm) {
  elements.customerScreeningForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/api/screening/customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formToJson(elements.customerScreeningForm)),
    });
    renderScreeningResult(elements.customerScreeningResults, await response.json());
  });
}

if (elements.paymentScreeningForm) {
  elements.paymentScreeningForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/api/screening/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formToJson(elements.paymentScreeningForm)),
    });
    renderScreeningResult(elements.paymentScreeningResults, await response.json());
  });
}

loadRfiEmailConfig();

fetch('/api/snapshot')
  .then((response) => response.json())
  .then(setSnapshot);

const stream = new EventSource('/api/stream');

stream.addEventListener('open', () => {
  elements.connectionDot?.classList.add('online');
  if (elements.connectionText) elements.connectionText.textContent = 'Live stream connected';
});

stream.addEventListener('snapshot', (event) => {
  setSnapshot(JSON.parse(event.data));
});

stream.addEventListener('transaction', (event) => {
  upsert(state.transactions, JSON.parse(event.data));
  renderTransactions();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
  refreshCustomerRisk();
  renderTransactionDetailPage();
});

stream.addEventListener('transactionUpdate', (event) => {
  const transaction = JSON.parse(event.data);
  upsert(state.transactions, transaction);
  if (state.detailSeed?.id === transaction.id) state.detailSeed = transaction;
  updateAssessmentResult(transaction);
  renderTransactions();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
  refreshCustomerRisk();
});

stream.addEventListener('alert', (event) => {
  upsert(state.alerts, JSON.parse(event.data));
  populateInvestigationFilters();
  renderAlerts();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
  refreshCustomerRisk();
});

stream.addEventListener('alertUpdate', (event) => {
  upsert(state.alerts, JSON.parse(event.data));
  populateInvestigationFilters();
  renderAlerts();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
  refreshCustomerRisk();
});

stream.addEventListener('case', (event) => {
  upsert(state.cases, JSON.parse(event.data));
  populateInvestigationFilters();
  renderCases();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
});

stream.addEventListener('caseUpdate', (event) => {
  upsert(state.cases, JSON.parse(event.data));
  populateInvestigationFilters();
  renderCases();
  renderDashboardCharts();
  renderAnalytics();
  renderOperationsQueue();
});

stream.addEventListener('audit', (event) => {
  upsert(state.auditLogs, JSON.parse(event.data));
  populateInvestigationFilters();
  renderAuditLogs();
});

stream.addEventListener('metrics', (event) => {
  state.metrics = JSON.parse(event.data);
  renderMetrics();
});

stream.addEventListener('charts', (event) => {
  state.charts = JSON.parse(event.data);
  renderCharts();
});

stream.addEventListener('analytics', (event) => {
  state.analytics = JSON.parse(event.data);
  renderAnalytics();
});

stream.addEventListener('error', () => {
  elements.connectionDot?.classList.remove('online');
  if (elements.connectionText) elements.connectionText.textContent = 'Reconnecting';
});
















