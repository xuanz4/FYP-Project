const express = require('express');
const path = require('path');
const {
  evaluateTransaction,
  companyRuleSets,
  normalizeRiskLevel,
  riskBands,
  serializeCompanyRuleSets,
  defaultRules,
} = require('./src/complianceEngine');
const { buildAnalytics } = require('./src/analyticsEngine');
const { buildCustomerRiskProfiles } = require('./src/customerRiskEngine');
const { screenCustomer, screenPayment, watchlist } = require('./src/screeningEngine');
const database = require('./src/database');

// Single-file Express entry point. The browser dashboard controller is defined in
// clientApp() below and is served at GET /app.js (see the route near the bottom).
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const companies = Object.values(companyRuleSets);
const serializedRuleSets = serializeCompanyRuleSets(companyRuleSets);
const transactions = [];
const alerts = [];
const cases = [];
const auditLogs = [];
const workflowStatuses = ['New', 'Under Review', 'Escalated', 'Resolved', 'False Positive'];

const countries = ['Singapore'];
const highRiskCountries = ['North Korea', 'Iran', 'Syria', 'Russia'];
const standardMerchantCategories = ['Retail Goods', 'Apparel', 'Footwear', 'Cosmetics', 'Household Goods'];
const riskyMerchantCategories = ['High-Value Retail', 'Premium Bundle'];
const channels = ['Card Present', 'Card Not Present', 'E-Commerce Card'];
const cardDirections = ['Sale', 'Refund'];
const counterparties = ['Harbour Retail Pte Ltd', 'Northbridge Luxury Resale', 'Orion Trade Holdings', 'Crimson Exchange', 'Maple Distribution'];
const customers = [
  { id: 'CUS-1001', name: 'Ava Lim', segment: 'Retail', kyc: 'Verified', customerRiskLevel: 'LOW' },
  { id: 'CUS-1002', name: 'Noah Tan', segment: 'SME', kyc: 'Verified', customerRiskLevel: 'MEDIUM' },
  { id: 'CUS-1003', name: 'Maya Wong', segment: 'Private Client', kyc: 'Enhanced Due Diligence', customerRiskLevel: 'HIGH' },
  { id: 'CUS-1004', name: 'Ethan Koh', segment: 'Retail', kyc: 'Pending Review', customerRiskLevel: 'HIGH' },
  { id: 'CUS-1005', name: 'Sophia Chen', segment: 'Corporate', kyc: 'Verified', customerRiskLevel: 'LOW' },
];
const normalCustomerPool = [customers[0], customers[0], customers[1], customers[1], customers[2], customers[4], customers[4]];

function queueDbWrite(action) {
  if (!database.isEnabled()) return;
  action().catch((error) => {
    console.error(`Database write failed: ${error.message}`);
  });
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pushLimited(list, item, limit = 250) {
  list.unshift(item);
  if (list.length > limit) list.pop();
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function logAudit(action, details = {}) {
  const entry = {
    id: id('AUD'),
    action,
    actor: details.actor || 'System',
    entityType: details.entityType || 'Monitoring',
    entityId: details.entityId || null,
    companyId: details.companyId || null,
    companyName: details.companyName || null,
    message: details.message,
    createdAt: new Date().toISOString(),
  };

  pushLimited(auditLogs, entry, 200);
  queueDbWrite(() => database.saveAuditLog(entry));
  broadcast('audit', entry);
  return entry;
}

function createTransaction(overrides = {}) {
  const company = overrides.companyId ? companies.find((item) => item.id === overrides.companyId) || companies[0] : pick(companies);
  const customer = Math.random() < 0.025 ? customers[3] : pick(normalCustomerPool);
  const isHighRiskCountry = Math.random() < 0.02;
  const isLargeTransaction = Math.random() < 0.055;
  const normalCeiling = company.id === 'companyB' ? 520 : 420;
  const largeCeiling = company.id === 'companyB' ? 2300 : 1400;
  const amountBase = isLargeTransaction ? 650 + Math.random() * largeCeiling : 35 + Math.random() * normalCeiling;
  const amount = Math.round(amountBase * 100) / 100;
  const merchantCategory = Math.random() < 0.03 ? pick(riskyMerchantCategories) : pick(standardMerchantCategories);
  const recentCompanyTransactions = Math.random() < 0.04 ? Math.floor(3 + Math.random() * 4) : Math.floor(Math.random() * 3);
  const cardSpend24h = amount + (Math.random() < 0.06 ? 900 + Math.random() * 1200 : Math.random() * 450);
  const nearThresholdCount = Math.random() < 0.035 ? 3 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 2);
  const lowValueBurstCount = Math.random() < 0.02 ? 5 + Math.floor(Math.random() * 4) : Math.floor(Math.random() * 3);
  const isNewCustomer = Math.random() < 0.08;
  const usualSpendBelow100 = Math.random() < 0.12;
  const counterpartyName = Math.random() < 0.045 ? pick(watchlist).name : pick(counterparties);
  const counterpartyCountry = isHighRiskCountry ? pick(highRiskCountries) : pick(countries);
  const transaction = {
    id: id('TXN'),
    companyId: company.id,
    companyName: company.name,
    merchantType: company.merchantType,
    mccCode: company.mccCode,
    industry: company.industry,
    industryRiskScore: company.industryRiskScore,
    merchantRiskLevel: normalizeRiskLevel(company.merchantRiskLevel),
    customerId: customer.id,
    customerName: customer.name,
    segment: customer.segment,
    kycStatus: customer.kyc,
    customerRiskLevel: normalizeRiskLevel(customer.customerRiskLevel),
    amount,
    currency: 'SGD',
    country: pick(countries),
    merchantCategory,
    recentCompanyTransactions,
    cardSpend24h,
    nearThresholdCount,
    lowValueBurstCount,
    isNewCustomer,
    usualSpendBelow100,
    channel: pick(channels),
    direction: pick(cardDirections),
    counterpartyName,
    counterpartyCountry: isHighRiskCountry ? pick(highRiskCountries) : counterpartyCountry,
    paymentReference: `${merchantCategory} purchase ${counterpartyName}`,
    status: 'Screening',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  transaction.customerRiskLevel = normalizeRiskLevel(transaction.customerRiskLevel);
  transaction.merchantRiskLevel = normalizeRiskLevel(transaction.merchantRiskLevel || company.merchantRiskLevel);

  const screening = screenPayment(transaction);
  const screeningRules = [];
  if (screening.matches.length) {
    screeningRules.push({
      id: 'SCR-001',
      name: 'Payment or customer screening match',
      risk: screening.matches.some((match) => match.type === 'Sanctions') ? 'High' : 'Medium',
      reason: `${screening.matches[0].type} match on ${screening.matches[0].field}`,
      weight: screening.matches.some((match) => match.type === 'Sanctions') ? 65 : 40,
    });
  }
  const result = evaluateTransaction(transaction, [...defaultRules, ...company.rules], screeningRules);
  const matchedRules = [...result.triggeredRules];

  transaction.screeningStatus = screening.status;
  transaction.screeningMatches = screening.matches;
  transaction.mccRiskScore = result.mccRiskScore;
  transaction.profileRiskScore = result.profileRiskScore;
  transaction.transactionDetectionScore = result.transactionDetectionScore;
  transaction.transactionHour = result.transactionHour;
  transaction.operatingHoursTriggered = result.operatingHoursTriggered;
  transaction.finalRiskScore = result.finalRiskScore;
  transaction.riskLevel = result.riskLevel;
  transaction.recommendedAction = result.recommendedAction;
  transaction.triggeredRules = result.triggeredRules;
  transaction.riskScore = result.finalRiskScore;
  transaction.riskBand = result.riskLevel;
  transaction.status = matchedRules.length ? 'Flagged' : 'Cleared';
  transaction.matchedRules = matchedRules;

  pushLimited(transactions, transaction);

  if (matchedRules.length) {
    const primaryRule = matchedRules[0];
    const duplicateAlert = alerts.find((alert) => (
      alert.customerId === transaction.customerId
      && alert.companyId === transaction.companyId
      && alert.primaryRuleId === primaryRule.id
      && !['Resolved', 'False Positive'].includes(alert.status)
    ));

    if (duplicateAlert) {
      duplicateAlert.transactionIds = [...new Set([...(duplicateAlert.transactionIds || [duplicateAlert.transactionId]), transaction.id])];
      duplicateAlert.transactionId = transaction.id;
      duplicateAlert.groupedCount = duplicateAlert.transactionIds.length;
      duplicateAlert.riskScore = Math.max(duplicateAlert.riskScore, transaction.riskScore);
      duplicateAlert.severity = riskBands(duplicateAlert.riskScore);
      duplicateAlert.finalRiskScore = Math.max(duplicateAlert.finalRiskScore || 0, transaction.finalRiskScore);
      duplicateAlert.riskLevel = riskBands(duplicateAlert.finalRiskScore);
      duplicateAlert.recommendedAction = transaction.recommendedAction;
      duplicateAlert.mccRiskScore = transaction.mccRiskScore;
      duplicateAlert.profileRiskScore = transaction.profileRiskScore;
      duplicateAlert.transactionDetectionScore = transaction.transactionDetectionScore;
      duplicateAlert.updatedAt = transaction.createdAt;
      logAudit('Alert Grouped', {
        entityType: 'Alert',
        entityId: duplicateAlert.id,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        message: `${transaction.id} grouped into existing alert ${duplicateAlert.id}`,
      });
      queueDbWrite(async () => {
        await database.saveTransaction(transaction);
        await database.saveAlert(duplicateAlert);
      });
      broadcast('alertUpdate', duplicateAlert);
    } else {
      const alert = {
        id: id('ALT'),
        transactionId: transaction.id,
        transactionIds: [transaction.id],
        groupedCount: 1,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        customerId: transaction.customerId,
        customerName: transaction.customerName,
        severity: transaction.riskBand,
        riskScore: transaction.riskScore,
        mccRiskScore: transaction.mccRiskScore,
        profileRiskScore: transaction.profileRiskScore,
        transactionDetectionScore: transaction.transactionDetectionScore,
        finalRiskScore: transaction.finalRiskScore,
        riskLevel: transaction.riskLevel,
        recommendedAction: transaction.recommendedAction,
        rules: matchedRules,
        primaryRuleId: primaryRule.id,
        status: 'New',
        analyst: 'Unassigned',
        createdAt: transaction.createdAt,
      };
      const complianceCase = {
        id: id('CASE'),
        alertId: alert.id,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        customerName: transaction.customerName,
        customerId: transaction.customerId,
        summary: `${transaction.currency} ${transaction.amount.toLocaleString()} ${transaction.direction.toLowerCase()} card transaction flagged`,
        priority: transaction.riskBand,
        status: 'New',
        owner: 'Operations Team',
        dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      };
      pushLimited(alerts, alert, 120);
      pushLimited(cases, complianceCase, 80);
      logAudit('Alert Created', {
        entityType: 'Alert',
        entityId: alert.id,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        message: `${alert.severity} alert opened for ${transaction.companyName} transaction by ${transaction.customerName}`,
      });
      logAudit('Case Created', {
        entityType: 'Case',
        entityId: complianceCase.id,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        message: `Case generated from alert ${alert.id}`,
      });
      queueDbWrite(async () => {
        await database.saveTransaction(transaction);
        await database.saveAlert(alert);
        await database.saveCase(complianceCase);
      });
      broadcast('alert', alert);
      broadcast('case', complianceCase);
    }
  } else {
    queueDbWrite(() => database.saveTransaction(transaction));
  }

  broadcast('transaction', transaction);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  broadcast('analytics', getAnalytics());
  return transaction;
}

function getMetrics() {
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const highRisk = transactions.filter((txn) => ['High', 'Critical'].includes(txn.riskBand)).length;
  const openAlerts = alerts.filter((alert) => alert.status === 'New').length;
  const activeAlerts = alerts.filter((alert) => !['Resolved', 'False Positive'].includes(alert.status)).length;
  const valueScreened = transactions.reduce((sum, txn) => sum + txn.amount, 0);

  return {
    total,
    flagged,
    highRisk,
    openAlerts,
    activeAlerts,
    valueScreened,
    flagRate: total ? Math.round((flagged / total) * 100) : 0,
  };
}

function getCharts() {
  const riskOrder = ['Critical', 'High', 'Medium', 'Low'];
  const riskCounts = riskOrder.map((risk) => ({
    label: risk,
    value: transactions.filter((txn) => txn.riskBand === risk).length,
  }));

  const disposition = [
    { label: 'Flagged', value: transactions.filter((txn) => txn.status === 'Flagged').length },
    { label: 'Cleared', value: transactions.filter((txn) => txn.status === 'Cleared').length },
  ];

  const alertStatus = workflowStatuses.map((status) => ({
    label: status,
    value: alerts.filter((alert) => alert.status === status).length,
  }));

  const countryCounts = transactions.reduce((summary, txn) => {
    summary[txn.country] = (summary[txn.country] || 0) + 1;
    return summary;
  }, {});

  const topCountries = Object.entries(countryCounts)
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 6);

  return {
    riskCounts,
    disposition,
    alertStatus,
    topCountries,
  };
}

function getAnalytics() {
  return buildAnalytics(transactions, alerts, cases);
}

function getCustomerRiskProfiles() {
  return buildCustomerRiskProfiles(transactions, alerts);
}

function findTransactionById(transactionId) {
  return transactions.find((transaction) => transaction.id === transactionId) || null;
}

function renderPage(view, title, activePage) {
  return (req, res) => {
    res.render(view, { title, activePage });
  };
}

app.get('/', renderPage('dashboard', 'Compliance Dashboard', 'dashboard'));
app.get('/dashboard', renderPage('dashboard', 'Compliance Dashboard', 'dashboard'));
app.get('/analytics', renderPage('analytics', 'Analytics', 'analytics'));
app.get('/diligence', renderPage('diligence', 'Due Diligence', 'diligence'));
app.get('/investigations', renderPage('investigations', 'Investigations', 'investigations'));
app.get('/rules', renderPage('rules', 'Compliance Rules', 'rules'));
app.get('/transactions/:id', (req, res) => {
  const transaction = findTransactionById(req.params.id);
  if (!transaction) {
    return res.status(404).render('transaction-detail', {
      title: 'Transaction Not Found',
      activePage: 'dashboard',
      transaction: null,
    });
  }

  res.render('transaction-detail', {
    title: `Transaction ${transaction.id}`,
    activePage: 'dashboard',
    transaction,
  });
});

app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/analytics.html', (req, res) => res.redirect(301, '/analytics'));
app.get('/charts', (req, res) => res.redirect(301, '/analytics#charts'));
app.get('/analyze', (req, res) => res.redirect(301, '/analytics#analytics'));
app.get('/customers', (req, res) => res.redirect(301, '/diligence'));
app.get('/screening', (req, res) => res.redirect(301, '/diligence'));
app.get('/alerts', (req, res) => res.redirect(301, '/investigations'));
app.get('/audit', (req, res) => res.redirect(301, '/investigations#audit'));
app.get('/cases', (req, res) => res.redirect(301, '/investigations#cases'));
app.get('/diligence.html', (req, res) => res.redirect(301, '/diligence'));
app.get('/investigations.html', (req, res) => res.redirect(301, '/investigations'));
app.get('/charts.html', (req, res) => res.redirect(301, '/analytics#charts'));
app.get('/analyze.html', (req, res) => res.redirect(301, '/analytics#analytics'));
app.get('/customers.html', (req, res) => res.redirect(301, '/diligence'));
app.get('/screening.html', (req, res) => res.redirect(301, '/diligence'));
app.get('/alerts.html', (req, res) => res.redirect(301, '/investigations'));
app.get('/audit.html', (req, res) => res.redirect(301, '/investigations#audit'));
app.get('/cases.html', (req, res) => res.redirect(301, '/investigations#cases'));
app.get('/rules.html', (req, res) => res.redirect(301, '/rules'));

// Browser dashboard controller, served as a plain script at /app.js. Kept as a
// function here (rather than a separate public/app.js file) so the whole app
// lives in this one file; its source text is extracted and sent as-is below.
function clientApp() {
  function loadTransactionStatusOverrides() {
    if (typeof window === 'undefined' || !window.sessionStorage) return {};

    try {
      return JSON.parse(window.sessionStorage.getItem('uniwebTransactionOverrides') || '{}');
    } catch (error) {
      return {};
    }
  }

  function persistTransactionStatusOverride(transactionId, override) {
    if (typeof window === 'undefined' || !window.sessionStorage) return;

    const existing = loadTransactionStatusOverrides();
    existing[transactionId] = {
      ...(existing[transactionId] || {}),
      ...override,
    };
    window.sessionStorage.setItem('uniwebTransactionOverrides', JSON.stringify(existing));
    state.transactionStatusOverrides = existing;
  }

  function statusClass(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function applyTransactionOverride(transaction) {
    const override = state.transactionStatusOverrides?.[transaction.id];
    return override ? { ...transaction, ...override } : transaction;
  }

  function applyTransactionOverrides() {
    state.transactions = state.transactions.map((transaction) => applyTransactionOverride(transaction));
    state.detailSeed = state.detailSeed ? applyTransactionOverride(state.detailSeed) : null;
  }

  function isFinalTransactionStatus(status) {
    return ['Pending RFI', 'STR Filed', 'Dismissed as False Positive', 'Escalated'].includes(status);
  }

  function getTransactionActionStatus(action) {
    return {
      rfi: 'Pending RFI',
      str: 'STR Filed',
      dismiss: 'Dismissed as False Positive',
      escalate: 'Escalated',
    }[action];
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
    companyFilter: 'All',
    transactionStatusOverrides: loadTransactionStatusOverrides(),
    detailSeed,
    detailTransactionId: document.querySelector('[data-transaction-detail-page]')?.dataset.transactionId || detailSeed?.id || null,
  };

  const workflowStatuses = ['New', 'Under Review', 'Escalated', 'Resolved', 'False Positive'];

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
    flagRateMetric: document.querySelector('#flagRateMetric'),
    activeAlertsMetric: document.querySelector('#activeAlertsMetric'),
    valueMetric: document.querySelector('#valueMetric'),
    transactionRows: document.querySelector('#transactionRows'),
    operationsQueue: document.querySelector('#operationsQueue'),
    alertList: document.querySelector('#alertList'),
    caseList: document.querySelector('#caseList'),
    auditList: document.querySelector('#auditList'),
    ruleList: document.querySelector('#ruleList'),
    companyRuleTabs: document.querySelector('#companyRuleTabs'),
    companyRuleDetail: document.querySelector('#companyRuleDetail'),
    riskChart: document.querySelector('#riskChart'),
    dispositionChart: document.querySelector('#dispositionChart'),
    alertStatusChart: document.querySelector('#alertStatusChart'),
    countryChart: document.querySelector('#countryChart'),
    analysisFlagRate: document.querySelector('#analysisFlagRate'),
    analysisHighRiskRate: document.querySelector('#analysisHighRiskRate'),
    analysisEscalated: document.querySelector('#analysisEscalated'),
    analysisOverdue: document.querySelector('#analysisOverdue'),
    analysisInsights: document.querySelector('#analysisInsights'),
    analysisDrivers: document.querySelector('#analysisDrivers'),
    analysisCountries: document.querySelector('#analysisCountries'),
    analysisCompanies: document.querySelector('#analysisCompanies'),
    analysisCustomers: document.querySelector('#analysisCustomers'),
    customerRiskRows: document.querySelector('#customerRiskRows'),
    customerScreeningForm: document.querySelector('#customerScreeningForm'),
    customerScreeningResults: document.querySelector('#customerScreeningResults'),
    paymentScreeningForm: document.querySelector('#paymentScreeningForm'),
    paymentScreeningResults: document.querySelector('#paymentScreeningResults'),
    watchlistRows: document.querySelector('#watchlistRows'),
    connectionDot: document.querySelector('#connectionDot'),
    connectionText: document.querySelector('#connectionText'),
    riskFilter: document.querySelector('#riskFilter'),
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
    applyTransactionOverrides();
    populateCompanyFilter();
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
    elements.companyFilter.innerHTML = '<option value="All">All Merchant Profiles</option>' + state.ruleSets.map((company) => `
      <option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>
    `).join('');
    elements.companyFilter.value = state.ruleSets.some((company) => company.id === current) ? current : 'All';
    state.companyFilter = elements.companyFilter.value;
  }

  function matchesCompany(item) {
    return state.companyFilter === 'All' || item.companyId === state.companyFilter;
  }

  function getFilteredTransactions() {
    return state.transactions.filter(matchesCompany);
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
    return state.auditLogs.filter(matchesCompany);
  }

  function getFilteredMetrics() {
    const transactions = getFilteredTransactions();
    const alerts = getFilteredAlerts();
    const total = transactions.length;
    const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
    const activeAlerts = alerts.filter((alert) => !['Resolved', 'False Positive'].includes(alert.status)).length;
    const valueScreened = transactions.reduce((sum, txn) => sum + txn.amount, 0);
    return {
      total,
      flagged,
      activeAlerts,
      valueScreened,
      flagRate: total ? Math.round((flagged / total) * 100) : 0,
    };
  }

  function getFilteredCharts() {
    const transactions = getFilteredTransactions();
    const alerts = getFilteredAlerts();
    const riskOrder = ['Critical', 'High', 'Medium', 'Low'];
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
      alertStatus: workflowStatuses.map((status) => ({ label: status, value: alerts.filter((alert) => alert.status === status).length })),
      topCountries: Object.entries(countryCounts)
        .map(([label, value]) => ({ label, value }))
        .sort((left, right) => right.value - left.value)
        .slice(0, 6),
    };
  }

  function render() {
    renderMetrics();
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

  function renderMetrics() {
    if (!elements.totalMetric) return;
    const metrics = getFilteredMetrics();
    elements.totalMetric.textContent = metrics.total || 0;
    elements.flagRateMetric.textContent = `${metrics.flagRate || 0}%`;
    elements.activeAlertsMetric.textContent = metrics.activeAlerts || 0;
    elements.valueMetric.textContent = money.format(metrics.valueScreened || 0);
  }

  function renderCharts() {
    const charts = getFilteredCharts();
    renderBarChart(elements.riskChart, charts.riskCounts || []);
    renderBarChart(elements.dispositionChart, charts.disposition || []);
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
    const transactions = getFilteredTransactions();
    const alerts = getFilteredAlerts();
    const cases = getFilteredCases();
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
    if (percent(flagged, total) >= 35) insights.push('Flag rate is elevated. Review threshold tuning and recent merchant activity.');
    if (highRisk >= 5) insights.push('High and critical risk transactions are building up. Prioritize escalation review.');
    if (activeAlerts >= 10) insights.push('Active alert workload is high. Assign analysts before SLA pressure increases.');
    if (escalatedAlerts > 0) insights.push('Escalated alerts are present. Confirm investigation notes and next actions.');
    if (overdueCases > 0) insights.push('Some cases are past due. Reorder the queue by due date and priority.');
    if (!insights.length) insights.push('Current monitoring activity is stable. Keep watching for new high-risk rule clusters.');

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
      countries: topSummaries(summarizeBy(transactions, (txn) => txn.country), 5),
      companies: topSummaries(summarizeBy(transactions, (txn) => txn.companyName || txn.companyId), 5),
      customers: topSummaries(summarizeBy(transactions, (txn) => txn.customerName || txn.customerId), 5),
    };
  }

  function renderAnalytics() {
    if (!elements.analysisInsights) return;
    const analytics = getFilteredAnalytics();
    elements.analysisFlagRate.textContent = `${analytics.summary.flagRate}%`;
    elements.analysisHighRiskRate.textContent = `${analytics.summary.highRiskRate}%`;
    elements.analysisEscalated.textContent = analytics.summary.escalatedAlerts;
    elements.analysisOverdue.textContent = analytics.summary.overdueCases;

    elements.analysisInsights.innerHTML = analytics.insights.map((insight) => `
      <article class="insight-item">
        <strong>${escapeHtml(insight)}</strong>
      </article>
    `).join('');

    renderAnalysisRows(elements.analysisDrivers, analytics.drivers, (item) => `
      <strong>${escapeHtml(item.label)}</strong>
      <span>${item.count} matches - avg weight ${item.averageWeight}</span>
    `);
    renderAnalysisRows(elements.analysisCountries, analytics.countries, renderExposureRow);
    renderAnalysisRows(elements.analysisCompanies, analytics.companies, renderExposureRow);
    renderAnalysisRows(elements.analysisCustomers, analytics.customers, renderExposureRow);
  }

  function renderExposureRow(item) {
    return `
      <strong>${escapeHtml(item.label)}</strong>
      <span>${item.flagged}/${item.count} flagged - ${item.flagRate}% flag rate - avg risk ${item.averageRisk} - ${money.format(item.amount)}</span>
    `;
  }

  function renderAnalysisRows(target, rows, renderer) {
    if (!target) return;
    target.innerHTML = rows.map((row) => `
      <article class="analysis-row">
        ${renderer(row)}
      </article>
    `).join('') || '<p class="muted">No analysis data yet.</p>';
  }

  function renderCustomerRisk() {
    if (!elements.customerRiskRows) return;
    const rows = state.customerRiskProfiles
      .filter(matchesCompany)
      .slice(0, 50)
      .map((profile) => `
        <tr>
          <td>
            <strong>${escapeHtml(profile.customerName)}</strong>
            <div class="muted">${escapeHtml(profile.customerId)}</div>
          </td>
          <td>${escapeHtml(profile.companyName || 'Merchant Profile')}</td>
          <td>${escapeHtml(profile.kycStatus)}</td>
          <td>${escapeHtml(profile.screeningStatus)}</td>
          <td>${profile.transactionCount} / ${money.format(profile.totalValue)}</td>
          <td>${profile.openAlerts}</td>
          <td><span class="badge risk-${profile.riskBand.toLowerCase()}">${profile.riskBand} ${profile.riskScore}</span></td>
          <td>${profile.riskDrivers.map(escapeHtml).join(', ')}</td>
        </tr>
      `)
      .join('');

    elements.customerRiskRows.innerHTML = rows || '<tr><td colspan="8">No customer risk profiles yet.</td></tr>';
  }

  function renderWatchlist() {
    if (!elements.watchlistRows) return;
    renderAnalysisRows(elements.watchlistRows, state.watchlist, (entry) => `
      <strong>${escapeHtml(entry.name)}</strong>
      <span>${escapeHtml(entry.type)} - ${escapeHtml(entry.country)} - ${escapeHtml(entry.risk)} - ${escapeHtml(entry.reason)}</span>
    `);
  }

  function renderScreeningResult(target, result) {
    if (!target) return;
    const matches = result.matches || [];
    target.innerHTML = `
      <article class="screening-summary">
        <strong>${escapeHtml(result.status || 'Clear')}</strong>
        <span>Highest match score: ${escapeHtml(result.highestScore || 0)}</span>
      </article>
      ${matches.map((match) => `
        <article class="analysis-row">
          <strong>${escapeHtml(match.name)}</strong>
          <span>${escapeHtml(match.type)} - ${escapeHtml(match.field)} - score ${escapeHtml(match.score)} - ${escapeHtml(match.reason)}</span>
        </article>
      `).join('') || '<p class="muted">No list matches found.</p>'}
    `;
  }

  function formToJson(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function renderTransactions() {
    if (!elements.transactionRows) return;
    const rows = getFilteredTransactions()
      .filter((txn) => state.riskFilter === 'All' || txn.riskBand === state.riskFilter)
      .slice(0, 35)
      .map((txn) => `
        <tr class="transaction-row" data-transaction-id="${escapeHtml(txn.id)}">
          <td>${time.format(new Date(txn.createdAt))}</td>
          <td>
            <strong>${escapeHtml(txn.customerName)}</strong>
            <div class="muted">${escapeHtml(txn.customerId)}</div>
          </td>
          <td><strong>${escapeHtml(txn.companyName || 'Merchant Profile')}</strong><div class="muted">${escapeHtml(txn.merchantType || txn.merchantCategory)}</div></td>
          <td>${money.format(txn.amount)}</td>
          <td>${escapeHtml(txn.country)}</td>
          <td>${escapeHtml(txn.channel)}</td>
          <td><span class="badge risk-${statusClass(txn.riskBand)}">${txn.riskBand} ${txn.riskScore}</span></td>
          <td><span class="transaction-status status-${statusClass(txn.status)}">${txn.status}</span></td>
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

  function renderAlerts() {
    if (!elements.alertList) return;
    elements.alertList.innerHTML = getFilteredAlerts().slice(0, 30).map((alert) => `
      <article class="alert">
        <div class="alert-top">
          <strong>${escapeHtml(alert.customerName)}</strong>
          <span class="badge risk-${alert.severity.toLowerCase()}">${alert.severity}</span>
        </div>
        <p>${alert.rules.map((rule) => escapeHtml(rule.name)).join(', ')}</p>
        <div class="meta">${escapeHtml(alert.companyName || 'Merchant Profile')} &middot; ${escapeHtml(alert.id)} &middot; Latest ${escapeHtml(alert.transactionId)} &middot; ${escapeHtml(alert.groupedCount || 1)} transaction(s) &middot; Score ${escapeHtml(alert.riskScore)} &middot; ${time.format(new Date(alert.createdAt))} &middot; ${escapeHtml(alert.status)} &middot; ${escapeHtml(alert.analyst)}</div>
        <div class="alert-actions">
          ${workflowStatuses.map((status) => `
            <button type="button" class="secondary-btn" data-alert-id="${escapeHtml(alert.id)}" data-status="${escapeHtml(status)}" ${alert.status === status ? 'disabled' : ''}>${escapeHtml(status)}</button>
          `).join('')}
        </div>
      </article>
    `).join('') || '<p class="muted">No open alerts.</p>';
  }

  function renderCases() {
    if (!elements.caseList) return;
    elements.caseList.innerHTML = getFilteredCases().slice(0, 30).map((item) => `
      <article class="case-item">
        <div class="case-top">
          <strong>${escapeHtml(item.id)}</strong>
          <span class="badge risk-${item.priority.toLowerCase()}">${item.priority}</span>
        </div>
        <p>${escapeHtml(item.summary)}</p>
        <div class="meta">${escapeHtml(item.companyName || 'Merchant Profile')} &middot; ${escapeHtml(item.customerName)} &middot; ${escapeHtml(item.status)} &middot; ${escapeHtml(item.owner || 'Operations Team')} &middot; Due ${new Date(item.dueAt).toLocaleDateString('en-SG')}</div>
        <div class="alert-actions">
          ${workflowStatuses.map((status) => `
            <button type="button" class="secondary-btn" data-case-id="${escapeHtml(item.id)}" data-status="${escapeHtml(status)}" ${item.status === status ? 'disabled' : ''}>${escapeHtml(status)}</button>
          `).join('')}
        </div>
      </article>
    `).join('') || '<p class="muted">No cases generated.</p>';
  }

  function renderOperationsQueue() {
    if (!elements.operationsQueue) return;
    const queue = getFilteredTransactions()
      .filter((txn) => txn.status === 'Flagged' && txn.riskBand === 'Critical')
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
      .slice(0, 25);

    elements.operationsQueue.innerHTML = queue.length
      ? `
        <div class="table-wrap">
          <table class="queue-table">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Customer</th>
                <th>Merchant Profile</th>
                <th>Amount</th>
                <th>Location</th>
                <th>Risk</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${queue.map((txn) => `
                <tr class="transaction-row" data-queue-transaction-id="${escapeHtml(txn.id)}">
                  <td>${new Date(txn.createdAt).toLocaleString('en-SG')}</td>
                  <td>
                    <strong>${escapeHtml(txn.customerName)}</strong>
                    <div class="muted">${escapeHtml(txn.customerId)}</div>
                  </td>
                  <td>
                    <strong>${escapeHtml(txn.companyName || 'Merchant Profile')}</strong>
                    <div class="muted">${escapeHtml(txn.merchantType || txn.merchantCategory)}</div>
                  </td>
                  <td>${money.format(txn.amount)}</td>
                  <td>${escapeHtml(txn.country)}</td>
                  <td><span class="badge risk-${statusClass(txn.riskBand)}">${txn.riskBand} ${txn.riskScore}</span></td>
                  <td class="transaction-actions queue-actions">
                    <button type="button" class="secondary-btn review-btn queue-review-btn" data-review-transaction-id="${escapeHtml(txn.id)}">Review</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
      : '<p class="muted">No critical transactions in the queue.</p>';
  }

  function renderAuditLogs() {
    if (!elements.auditList) return;
    elements.auditList.innerHTML = getFilteredAuditLogs().slice(0, 40).map((entry) => `
      <article class="audit-item">
        <div class="audit-dot"></div>
        <div>
          <div class="audit-top">
            <strong>${escapeHtml(entry.action)}</strong>
            <span>${time.format(new Date(entry.createdAt))}</span>
          </div>
          <p>${escapeHtml(entry.message || '')}</p>
          <div class="meta">${escapeHtml(entry.companyName || 'All Merchant Profiles')} &middot; ${escapeHtml(entry.actor)} &middot; ${escapeHtml(entry.entityType)}${entry.entityId ? ` &middot; ${escapeHtml(entry.entityId)}` : ''}</div>
        </div>
      </article>
    `).join('') || '<p class="muted">No audit activity yet.</p>';
  }

  function renderRules() {
    if (!elements.companyRuleTabs || !elements.companyRuleDetail) return;
    const ruleSets = state.ruleSets || [];
    if (!ruleSets.length) {
      elements.companyRuleDetail.innerHTML = '<p class="muted">No merchant profile rules available.</p>';
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
        <div class="company-view-pill">MCC ${escapeHtml(selected.mccCode || 'N/A')}</div>
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

  function openTransactionDetails(transactionId) {
    window.location.assign(`/transactions/${encodeURIComponent(transactionId)}`);
  }

  let activeTransactionAction = null;

  function renderTransactionDetailPage() {
    if (!elements.transactionDetailPage) return;

    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;

    const current = applyTransactionOverride(transaction);
    if (elements.transactionDetailStatus) {
      elements.transactionDetailStatus.className = `badge transaction-status-badge status-${statusClass(current.status)}`;
      elements.transactionDetailStatus.textContent = current.status;
    }

    if (elements.transactionDetailConfirmation) {
      const actionLabel = current.actionLabel || current.reviewAction || null;
      elements.transactionDetailConfirmation.textContent = isFinalTransactionStatus(current.status)
        ? `${actionLabel ? `${actionLabel} completed. ` : ''}No further action is needed for this transaction.`
        : 'Choose an action to continue the review workflow.';
    }

    const buttonContainer = elements.transactionDetailActionButtons;
    if (buttonContainer) {
      const completed = isFinalTransactionStatus(current.status);
      buttonContainer.querySelectorAll('[data-transaction-action]').forEach((button) => {
        button.disabled = completed;
      });
    }

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

  function openTransactionActionForm(action) {
    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;
    if (isFinalTransactionStatus(applyTransactionOverride(transaction).status)) return;

    activeTransactionAction = action;
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

  function updateTransactionDetailStatus(transactionId, status, actionLabel, source) {
    persistTransactionStatusOverride(transactionId, {
      status,
      actionLabel,
      reviewAction: source,
      updatedAt: new Date().toISOString(),
    });

    state.transactions = state.transactions.map((transaction) => (
      transaction.id === transactionId
        ? applyTransactionOverride({ ...transaction, status, actionLabel, reviewAction: source, updatedAt: new Date().toISOString() })
        : transaction
    ));

    if (state.detailSeed && state.detailSeed.id === transactionId) {
      state.detailSeed = applyTransactionOverride({ ...state.detailSeed, status, actionLabel, reviewAction: source, updatedAt: new Date().toISOString() });
    }

    if (elements.transactionDetailConfirmation) {
      elements.transactionDetailConfirmation.textContent = `${actionLabel} completed. No further action is needed for this transaction.`;
    }

    render();
  }

  function finalizeTransactionAction(action, extra = {}) {
    const transaction = getTransactionById(state.detailTransactionId);
    if (!transaction) return;

    const status = getTransactionActionStatus(action);
    if (!status) return;

    updateTransactionDetailStatus(transaction.id, status, extra.actionLabel || status, action);
    closeTransactionActionForm();
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

  if (elements.transactionDetailActionButtons) {
    elements.transactionDetailActionButtons.addEventListener('click', (event) => {
      const button = event.target.closest('[data-transaction-action]');
      if (!button) return;

      const action = button.dataset.transactionAction;
      if (action === 'rfi' || action === 'str') {
        openTransactionActionForm(action);
        return;
      }

      const transaction = getTransactionById(state.detailTransactionId);
      if (!transaction || isFinalTransactionStatus(applyTransactionOverride(transaction).status)) return;

      const status = getTransactionActionStatus(action);
      if (!status) return;

      updateTransactionDetailStatus(transaction.id, status, button.textContent.trim(), action);
      updateTransactionDetailActionFeedback(`${button.textContent.trim()} completed. No further action is needed for this transaction.`);
    });
  }

  if (elements.transactionActionForm) {
    elements.transactionActionForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const action = elements.transactionActionType?.value || activeTransactionAction;
      if (!action) return;

      const label = action === 'rfi' ? 'Request for Information' : 'File STR';
      finalizeTransactionAction(action, { actionLabel: label });
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
    elements.alertList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-alert-id]');
      if (!button) return;

      button.disabled = true;
      await updateAlertStatus(button.dataset.alertId, button.dataset.status);
    });
  }

  if (elements.caseList) {
    elements.caseList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-case-id]');
      if (!button) return;

      button.disabled = true;
      await updateCaseStatus(button.dataset.caseId, button.dataset.status);
    });
  }

  if (elements.simulateBtn) {
    elements.simulateBtn.addEventListener('click', async () => {
      elements.simulateBtn.disabled = true;
      try {
        await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: 'Manual High-Risk Card Review',
            amount: 12500,
            country: 'Singapore',
            counterpartyCountry: 'Iran',
            merchantCategory: 'High-Value Retail',
            channel: 'E-Commerce Card',
            direction: 'Sale',
            actor: 'Analyst Ryan',
          }),
        });
      } finally {
        elements.simulateBtn.disabled = false;
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
    applyTransactionOverrides();
    renderTransactions();
    renderAnalytics();
    renderOperationsQueue();
    refreshCustomerRisk();
    renderTransactionDetailPage();
  });

  stream.addEventListener('alert', (event) => {
    upsert(state.alerts, JSON.parse(event.data));
    renderAlerts();
    renderAnalytics();
    renderOperationsQueue();
    refreshCustomerRisk();
  });

  stream.addEventListener('alertUpdate', (event) => {
    upsert(state.alerts, JSON.parse(event.data));
    renderAlerts();
    renderAnalytics();
    renderOperationsQueue();
    refreshCustomerRisk();
  });

  stream.addEventListener('case', (event) => {
    upsert(state.cases, JSON.parse(event.data));
    renderCases();
    renderAnalytics();
    renderOperationsQueue();
  });

  stream.addEventListener('caseUpdate', (event) => {
    upsert(state.cases, JSON.parse(event.data));
    renderCases();
    renderAnalytics();
    renderOperationsQueue();
  });

  stream.addEventListener('audit', (event) => {
    upsert(state.auditLogs, JSON.parse(event.data));
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
}

function clientAppSource(fn) {
  const source = fn.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
}

app.get('/app.js', (req, res) => {
  res.type('application/javascript');
  res.send(clientAppSource(clientApp));
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(getSnapshot())}\n\n`);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.get('/api/snapshot', (req, res) => {
  res.json(getSnapshot());
});

app.get('/api/transactions/:id', (req, res) => {
  const transaction = findTransactionById(req.params.id);
  if (!transaction) return res.status(404).json({ error: 'transaction not found' });
  res.json(transaction);
});

app.get('/api/analytics', (req, res) => {
  res.json(getAnalytics());
});

app.get('/api/customers/risk', (req, res) => {
  res.json(getCustomerRiskProfiles());
});

app.get('/api/watchlist', (req, res) => {
  res.json(watchlist);
});

app.post('/api/screening/customer', (req, res) => {
  const name = req.body.name || req.body.customerName;
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(screenCustomer({ name, country: req.body.country }));
});

app.post('/api/screening/payment', (req, res) => {
  res.json(screenPayment(req.body));
});

app.post('/api/transactions', (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const transaction = createTransaction({
    customerName: req.body.customerName || 'Manual Review Customer',
    customerId: req.body.customerId || id('CUS'),
    segment: req.body.segment || 'Manual',
    kycStatus: req.body.kycStatus || 'Verified',
    customerRiskLevel: normalizeRiskLevel(req.body.customerRiskLevel || 'LOW'),
    amount,
    country: 'Singapore',
    counterpartyCountry: req.body.counterpartyCountry || req.body.contextCountry || 'Singapore',
    merchantCategory: req.body.merchantCategory || 'Premium Bundle',
    channel: channels.includes(req.body.channel) ? req.body.channel : 'E-Commerce Card',
    direction: cardDirections.includes(req.body.direction) ? req.body.direction : 'Sale',
    companyId: req.body.companyId || 'companyA',
    merchantRiskLevel: req.body.merchantRiskLevel ? normalizeRiskLevel(req.body.merchantRiskLevel) : undefined,
  });

  logAudit('Manual Transaction Submitted', {
    actor: req.body.actor || 'Analyst',
    entityType: 'Transaction',
    entityId: transaction.id,
    companyId: transaction.companyId,
    companyName: transaction.companyName,
    message: `Manual transaction screened for ${transaction.companyName} / ${transaction.customerName}`,
  });

  res.status(201).json(transaction);
});

app.patch('/api/alerts/:id', (req, res) => {
  const alert = alerts.find((item) => item.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });

  if (req.body.status && !workflowStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'invalid alert status' });
  }

  const previousStatus = alert.status;
  alert.status = req.body.status || alert.status;
  alert.analyst = req.body.analyst || alert.analyst;

  if (previousStatus !== alert.status) {
    logAudit('Alert Status Changed', {
      actor: alert.analyst,
      entityType: 'Alert',
      entityId: alert.id,
      companyId: alert.companyId,
      companyName: alert.companyName,
      message: `${alert.id} moved from ${previousStatus} to ${alert.status}`,
    });
  }

  queueDbWrite(() => database.updateAlert(alert));
  broadcast('alertUpdate', alert);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  broadcast('analytics', getAnalytics());
  res.json(alert);
});

app.patch('/api/cases/:id', (req, res) => {
  const complianceCase = cases.find((item) => item.id === req.params.id);
  if (!complianceCase) return res.status(404).json({ error: 'case not found' });

  if (req.body.status && !workflowStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'invalid case status' });
  }

  const previousStatus = complianceCase.status;
  complianceCase.status = req.body.status || complianceCase.status;
  complianceCase.owner = req.body.owner || complianceCase.owner || 'Operations Team';
  complianceCase.updatedAt = new Date().toISOString();

  if (previousStatus !== complianceCase.status) {
    logAudit('Case Status Changed', {
      actor: complianceCase.owner,
      entityType: 'Case',
      entityId: complianceCase.id,
      companyId: complianceCase.companyId,
      companyName: complianceCase.companyName,
      message: `${complianceCase.id} moved from ${previousStatus} to ${complianceCase.status}`,
    });
  }

  queueDbWrite(() => database.updateCase(complianceCase));
  broadcast('caseUpdate', complianceCase);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  broadcast('analytics', getAnalytics());
  res.json(complianceCase);
});

app.get('/api/rules', (req, res) => {
  res.json(serializedRuleSets);
});

function getSnapshot() {
  return {
    metrics: getMetrics(),
    transactions: transactions.slice(0, 80),
    alerts: alerts.slice(0, 50),
    cases: cases.slice(0, 30),
    auditLogs: auditLogs.slice(0, 60),
    ruleSets: serializedRuleSets,
    charts: getCharts(),
    analytics: getAnalytics(),
    customerRiskProfiles: getCustomerRiskProfiles(),
    watchlist,
  };
}

async function loadDatabaseData() {
  const connected = await database.initDatabase();
  if (!connected) return false;

  await Promise.all(companies.map((company) => database.upsertCompany(company)));
  const snapshot = await database.loadSnapshot();

  transactions.splice(0, transactions.length, ...snapshot.transactions);
  alerts.splice(0, alerts.length, ...snapshot.alerts);
  cases.splice(0, cases.length, ...snapshot.cases);
  auditLogs.splice(0, auditLogs.length, ...snapshot.auditLogs);

  return true;
}

async function startServer() {
  await loadDatabaseData();

  if (!transactions.length) {
    for (let index = 0; index < 24; index += 1) {
      createTransaction();
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`UNIWEB local (domestic) card-payment monitoring running on http://localhost:${PORT} - any Singapore merchant profile, MCC-driven risk classification`);
    setInterval(() => {
      createTransaction();
    }, 4000);
  });

  server.on('error', (error) => {
    console.error(`Server failed to listen on port ${PORT}: ${error.message}`);
    process.exit(1);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}

module.exports = app;
