const express = require('express');
require('dotenv').config();
const path = require('path');
const {
  evaluateTransaction,
  companyRuleSets,
  normalizeRiskLevel,
  riskBands,
  serializeCompanyRuleSets,
} = require('./src/complianceEngine');
const { buildAnalytics } = require('./src/analyticsEngine');
const { buildCustomerRiskProfiles } = require('./src/customerRiskEngine');
const { screenCustomer, screenPayment, watchlist } = require('./src/screeningEngine');
const database = require('./src/database');
const emailService = require('./src/services/emailService');

const app = express();
const PORT = process.env.PORT || 3000;
app.locals.emailService = emailService;

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
const workflowStatuses = ['New', 'Under Review', 'Waiting for Information', 'Escalated', 'Resolved', 'False Positive'];
const finalRiskLevels = ['Low', 'Medium', 'High', 'Critical'];
const assessmentDecisions = ['Accepted', 'Rejected', 'Escalated'];
const resolutionReasons = ['Legitimate Transaction', 'False Positive', 'Suspicious Activity', 'Insufficient Information', 'Other'];
const transactionActionTypes = ['RFI_REQUESTED', 'STR_FILED', 'CASE_ESCALATED'];

const countries = ['Singapore', 'Malaysia', 'United States', 'Indonesia', 'Thailand', 'Vietnam', 'United Arab Emirates'];
const highRiskCountries = ['North Korea', 'Iran', 'Syria', 'Russia'];
const standardMerchantCategories = ['Fashion', 'Footwear', 'Leather Goods', 'Skincare', 'Makeup'];
const riskyMerchantCategories = ['Luxury Resale', 'Premium Bundle'];
const channels = ['Card Present', 'E-Commerce', 'Wallet', 'Bank Transfer', 'ATM'];
const counterparties = ['Harbour Retail Pte Ltd', 'Northbridge Luxury Resale', 'Orion Trade Holdings', 'Crimson Exchange', 'Maple Distribution'];
const customers = [
  { id: 'CUS-1001', name: 'Ava Lim', email: 'ava.lim@example.com', accountType: 'Individual', authorisedContactName: null, authorisedContactEmail: null, segment: 'Retail', kyc: 'Verified', customerRiskLevel: 'LOW' },
  { id: 'CUS-1002', name: 'Noah Tan', email: 'noah.tan@example.com', accountType: 'Individual', authorisedContactName: null, authorisedContactEmail: null, segment: 'SME', kyc: 'Verified', customerRiskLevel: 'MEDIUM' },
  { id: 'CUS-1003', name: 'Maya Wong', email: 'maya.wong@example.com', accountType: 'Individual', authorisedContactName: null, authorisedContactEmail: null, segment: 'Private Client', kyc: 'Enhanced Due Diligence', customerRiskLevel: 'HIGH' },
  { id: 'CUS-1004', name: 'Ethan Koh', email: 'ethan.koh@example.com', accountType: 'Individual', authorisedContactName: null, authorisedContactEmail: null, segment: 'Retail', kyc: 'Pending Review', customerRiskLevel: 'HIGH' },
  { id: 'CUS-1005', name: 'Sophia Chen Trading Pte Ltd', email: null, accountType: 'Organisation', authorisedContactName: 'Sophia Chen', authorisedContactEmail: 'sophia.chen@example.com', segment: 'Corporate', kyc: 'Verified', customerRiskLevel: 'LOW' },
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

// Final risk score is chosen by level only, so analysts cannot type arbitrary scores.
function getFinalRiskScore(finalRiskLevel) {
  const scoreMap = {
    Low: 15,
    Medium: 40,
    High: 60,
    Critical: 80,
  };

  return scoreMap[finalRiskLevel];
}

function hasMeaningfulAnalystNotes(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 10) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
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
    transactionId: details.transactionId || null,
    alertId: details.alertId || null,
    caseId: details.caseId || null,
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

// Creates a new transaction, runs screening/risk scoring, and opens alerts/cases when rules are triggered.
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
    customerEmail: customer.email,
    accountType: customer.accountType,
    authorisedContactName: customer.authorisedContactName,
    authorisedContactEmail: customer.authorisedContactEmail,
    segment: customer.segment,
    kycStatus: customer.kyc,
    customerRiskLevel: normalizeRiskLevel(customer.customerRiskLevel),
    amount,
    currency: 'SGD',
    country: isHighRiskCountry ? pick(highRiskCountries) : pick(countries),
    merchantCategory,
    recentCompanyTransactions,
    cardSpend24h,
    nearThresholdCount,
    lowValueBurstCount,
    isNewCustomer,
    usualSpendBelow100,
    channel: pick(channels),
    direction: Math.random() > 0.5 ? 'Inbound' : 'Outbound',
    counterpartyName,
    counterpartyCountry,
    paymentReference: `${merchantCategory} purchase ${counterpartyName}`,
    status: 'Screening',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  transaction.customerRiskLevel = normalizeRiskLevel(transaction.customerRiskLevel);
  transaction.merchantRiskLevel = normalizeRiskLevel(transaction.merchantRiskLevel || company.merchantRiskLevel);
  const linkedCustomer = customers.find((item) => item.id === transaction.customerId);
  transaction.customerEmail = transaction.customerEmail ?? linkedCustomer?.email ?? null;
  transaction.accountType = transaction.accountType ?? linkedCustomer?.accountType ?? 'Individual';
  transaction.authorisedContactName = transaction.authorisedContactName ?? linkedCustomer?.authorisedContactName ?? null;
  transaction.authorisedContactEmail = transaction.authorisedContactEmail ?? linkedCustomer?.authorisedContactEmail ?? null;

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
  // Sends the transaction to src/complianceEngine.js to calculate the automated initial risk score.
  // Final risk stays empty until a future assessment/decision workflow assigns it.
  const result = evaluateTransaction(transaction, company.rules, screeningRules);
  const matchedRules = [...result.triggeredRules];

  transaction.screeningStatus = screening.status;
  transaction.screeningMatches = screening.matches;
  transaction.mccRiskScore = result.mccRiskScore;
  transaction.profileRiskScore = result.profileRiskScore;
  transaction.transactionDetectionScore = result.transactionDetectionScore;
  transaction.transactionHour = result.transactionHour;
  transaction.operatingHoursTriggered = result.operatingHoursTriggered;
  transaction.initialRiskScore = result.initialRiskScore;
  transaction.initialRiskLevel = result.initialRiskLevel;
  transaction.finalRiskScore = null;
  transaction.finalRiskLevel = null;
  transaction.riskLevel = result.initialRiskLevel;
  transaction.recommendedAction = result.recommendedAction;
  transaction.triggeredRules = result.triggeredRules;
  // Temporary compatibility fields for existing pages/charts that still read riskScore/riskBand.
  transaction.riskScore = result.initialRiskScore;
  transaction.riskBand = result.initialRiskLevel;
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
      duplicateAlert.initialRiskScore = Math.max(duplicateAlert.initialRiskScore || 0, transaction.initialRiskScore);
      duplicateAlert.initialRiskLevel = riskBands(duplicateAlert.initialRiskScore);
      duplicateAlert.finalRiskScore = null;
      duplicateAlert.finalRiskLevel = null;
      duplicateAlert.riskLevel = duplicateAlert.initialRiskLevel;
      duplicateAlert.recommendedAction = transaction.recommendedAction;
      duplicateAlert.mccRiskScore = transaction.mccRiskScore;
      duplicateAlert.profileRiskScore = transaction.profileRiskScore;
      duplicateAlert.transactionDetectionScore = transaction.transactionDetectionScore;
      duplicateAlert.updatedAt = transaction.createdAt;
      logAudit('Alert Grouped', {
        entityType: 'Alert',
        entityId: duplicateAlert.id,
        transactionId: transaction.id,
        alertId: duplicateAlert.id,
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
      initialRiskScore: transaction.initialRiskScore,
      initialRiskLevel: transaction.initialRiskLevel,
      finalRiskScore: transaction.finalRiskScore,
      finalRiskLevel: transaction.finalRiskLevel,
      riskLevel: transaction.initialRiskLevel,
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
        summary: `${transaction.currency} ${transaction.amount.toLocaleString()} ${transaction.direction.toLowerCase()} transaction flagged`,
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
        transactionId: transaction.id,
        alertId: alert.id,
        companyId: transaction.companyId,
        companyName: transaction.companyName,
        message: `${alert.severity} alert opened for ${transaction.companyName} transaction by ${transaction.customerName}`,
      });
      logAudit('Case Created', {
        entityType: 'Case',
        entityId: complianceCase.id,
        transactionId: transaction.id,
        alertId: alert.id,
        caseId: complianceCase.id,
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

// Calculates the dashboard summary numbers shown in views/dashboard.ejs.
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

function findAlertForTransaction(transactionId) {
  return alerts.find((item) => (
    item.transactionId === transactionId
    || (item.transactionIds || []).includes(transactionId)
  ));
}

function findCaseForTransaction(transactionId) {
  const alert = findAlertForTransaction(transactionId);
  if (!alert) return null;
  return cases.find((item) => item.alertId === alert.id) || null;
}

function isAssessmentResolvedForServer(transaction) {
  const complianceCase = findCaseForTransaction(transaction.id);
  return Boolean(
    transaction.finalRiskLevel
    || transaction.resolvedAt
    || transaction.assessmentStatus === 'Resolved'
    || complianceCase?.resolvedAt
    || complianceCase?.status === 'Resolved'
  );
}

function getAuditContextForTransaction(transaction) {
  const alert = findAlertForTransaction(transaction.id);
  const complianceCase = alert ? cases.find((item) => item.alertId === alert.id) || null : null;
  return { alert, complianceCase };
}

function getRfiRecipientForTransaction(transaction) {
  const customer = customers.find((item) => item.id === transaction.customerId);
  const accountType = transaction.accountType || customer?.accountType || 'Individual';
  const savedEmail = accountType === 'Organisation'
    ? (transaction.authorisedContactEmail ?? customer?.authorisedContactEmail ?? null)
    : (transaction.customerEmail ?? customer?.email ?? null);
  const savedName = accountType === 'Organisation'
    ? (transaction.authorisedContactName || customer?.authorisedContactName || transaction.customerName || customer?.name || 'Authorised Contact')
    : (transaction.customerName || customer?.name || 'Customer');
  const hasSavedEmail = Boolean(String(savedEmail || '').trim());
  return {
    id: transaction.customerId,
    accountType,
    accountName: transaction.customerName || customer?.name || 'Customer',
    recipientName: savedName,
    email: hasSavedEmail ? savedEmail : null,
    hasSavedEmail,
    emailLabel: hasSavedEmail
      ? (accountType === 'Organisation' ? 'Authorised contact email' : 'Customer email')
      : 'Temporary recipient email',
  };
}

function validateRfiRequestBody(body) {
  const allowedFields = ['subject', 'informationRequested'];
  const unsupportedFields = Object.keys(body || {}).filter((field) => !allowedFields.includes(field));
  if (unsupportedFields.length) {
    return `Unsupported field submitted: ${unsupportedFields[0]}`;
  }

  const subject = String(body?.subject || '').trim();
  const informationRequested = String(body?.informationRequested || '').trim();
  if (!subject) return 'Subject is required';
  if (!hasMeaningfulAnalystNotes(informationRequested)) {
    return 'Please provide a meaningful information request of at least 10 characters.';
  }

  const restrictedPhrase = emailService.findRestrictedPhrase(subject, informationRequested);
  if (restrictedPhrase) {
    return 'This message may disclose internal compliance information. Please use neutral verification wording.';
  }

  return null;
}

function getSafeEmailError(error) {
  const code = error.code || 'EMAIL_SEND_FAILED';
  const production = process.env.NODE_ENV === 'production';
  if (production) return { message: 'The RFI email could not be sent.', code };

  if (code === 'EAUTH') {
    return { message: 'Email authentication failed. Check EMAIL_USER and EMAIL_PASSWORD.', code };
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET') {
    return { message: 'Unable to connect to the email server.', code };
  }
  if (code === 'EENVELOPE') {
    return { message: 'Invalid sender or recipient email.', code };
  }
  if (code === 'EMISSINGCONFIG') {
    return { message: error.message, code };
  }
  return { message: 'The RFI email could not be sent.', code };
}

function isEmailDevelopmentMode() {
  return process.env.EMAIL_TEST_MODE === 'true'
    || String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase() === 'ethereal';
}

function getTransactionActivityLogs(transactionId) {
  return auditLogs
    .filter((entry) => (
      entry.transactionId === transactionId
      || (entry.entityType === 'Transaction' && entry.entityId === transactionId)
    ))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
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
      activityLogs: [],
      emailTestMode: isEmailDevelopmentMode(),
    });
  }

  let activityLogs = [];
  try {
    activityLogs = getTransactionActivityLogs(transaction.id);
  } catch (error) {
    console.error('Unable to load transaction activity logs', {
      transactionId: transaction.id,
      message: error.message,
    });
  }

  res.render('transaction-detail', {
    title: `Transaction ${transaction.id}`,
    activePage: 'dashboard',
    transaction,
    activityLogs: activityLogs || [],
    emailTestMode: isEmailDevelopmentMode(),
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

app.get('/api/transactions/:id/activity', (req, res) => {
  const transaction = findTransactionById(req.params.id);
  if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
  res.json({
    success: true,
    activityLogs: getTransactionActivityLogs(transaction.id),
  });
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

app.get('/api/rfi/config', (req, res) => {
  res.json(emailService.getEmailRuntimeConfig());
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
    customerEmail: Object.hasOwn(req.body, 'customerEmail') ? req.body.customerEmail : undefined,
    accountType: req.body.accountType,
    authorisedContactName: req.body.authorisedContactName,
    authorisedContactEmail: req.body.authorisedContactEmail,
    segment: req.body.segment || 'Manual',
    kycStatus: req.body.kycStatus || 'Verified',
    customerRiskLevel: normalizeRiskLevel(req.body.customerRiskLevel || 'LOW'),
    amount,
    country: req.body.country || 'Singapore',
    merchantCategory: req.body.merchantCategory || 'Premium Bundle',
    channel: req.body.channel || 'Bank Transfer',
    direction: req.body.direction || 'Outbound',
    companyId: req.body.companyId || 'companyA',
    merchantRiskLevel: req.body.merchantRiskLevel ? normalizeRiskLevel(req.body.merchantRiskLevel) : undefined,
  });

  logAudit('Manual Transaction Submitted', {
    actor: req.body.actor || 'Analyst',
    entityType: 'Transaction',
    entityId: transaction.id,
    transactionId: transaction.id,
    companyId: transaction.companyId,
    companyName: transaction.companyName,
    message: `Manual transaction screened for ${transaction.companyName} / ${transaction.customerName}`,
  });

  res.status(201).json(transaction);
});

app.post('/api/transactions/:id/rfi', async (req, res) => {
  console.log('RFI route reached:', req.params.id);

  const transaction = findTransactionById(req.params.id);
  if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

  if (isAssessmentResolvedForServer(transaction)) {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }

  const { alert, complianceCase } = getAuditContextForTransaction(transaction);
  const currentAssessmentStatus = transaction.assessmentStatus || complianceCase?.status || 'New';
  const isEtherealMode = String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase() === 'ethereal';
  if (currentAssessmentStatus === 'Waiting for Information' && !isEtherealMode) {
    return res.status(409).json({ success: false, message: 'Request for Information has already been sent' });
  }

  const validationMessage = validateRfiRequestBody(req.body);
  if (validationMessage) {
    return res.status(400).json({ success: false, message: validationMessage });
  }

  const recipient = getRfiRecipientForTransaction(transaction);
  if (!recipient || !recipient.recipientName) {
    return res.status(404).json({ success: false, message: 'Linked customer or organisation not found' });
  }
  if (!recipient.hasSavedEmail) {
    return res.status(400).json({ success: false, message: 'Saved recipient email is missing' });
  }
  if (!emailService.isValidEmail(recipient.email)) {
    return res.status(400).json({ success: false, message: 'Recipient email is missing or invalid' });
  }
  const recipientSource = 'stored';
  console.log('RFI recipient selected', {
    transactionId: transaction.id,
    recipientSource,
    provider: isEtherealMode ? 'ethereal' : 'smtp',
    deliveryRecipient: emailService.maskEmail(recipient.email),
  });

  const subject = String(req.body.subject || '').trim();
  const informationRequested = String(req.body.informationRequested || '').trim();
  const transactionDate = new Date(transaction.createdAt).toLocaleString('en-SG');
  const sender = app.locals.emailService || emailService;

  let delivery;
  try {
    delivery = await sender.sendRfiEmail({
      to: recipient.email,
      recipientName: recipient.recipientName,
      companyName: transaction.companyName,
      transactionId: transaction.id,
      transactionDate,
      currency: transaction.currency,
      amount: transaction.amount,
      subject,
      informationRequested,
    });
    console.log('RFI email service success', {
      transactionId: transaction.id,
      provider: delivery?.etherealMode ? 'ethereal' : 'smtp',
      recipientSource,
      accepted: delivery?.delivery?.accepted || [],
      rejected: delivery?.delivery?.rejected || [],
      pending: delivery?.delivery?.pending || [],
      response: delivery?.delivery?.response || null,
      messageId: delivery?.delivery?.messageId || null,
      previewUrl: delivery?.previewUrl || null,
    });
  } catch (error) {
    console.error('RFI email service failure', {
      transactionId: transaction.id,
      message: error.message,
    });
    const safeError = getSafeEmailError(error);
    return res.status(502).json({ success: false, ...safeError });
  }

  const updatedAt = new Date().toISOString();
  transaction.assessmentStatus = 'Waiting for Information';
  transaction.reviewAction = 'RFI_REQUESTED';
  transaction.updatedAt = updatedAt;

  if (complianceCase) {
    complianceCase.status = 'Waiting for Information';
    complianceCase.updatedAt = updatedAt;
  }

  const auditEntry = logAudit('Request for Information Sent', {
    actor: 'Analyst',
    entityType: complianceCase ? 'Case' : 'Transaction',
    entityId: complianceCase?.id || transaction.id,
    transactionId: transaction.id,
    alertId: alert?.id || null,
    caseId: complianceCase?.id || null,
    companyId: transaction.companyId,
    companyName: transaction.companyName,
    message: delivery?.testMode
      ? 'RFI email sent in test mode requesting supporting transaction information.'
      : 'RFI email sent requesting supporting transaction information.',
  });

  queueDbWrite(async () => {
    if (complianceCase) await database.updateCase(complianceCase);
  });

  broadcast('transactionUpdate', transaction);
  if (complianceCase) broadcast('caseUpdate', complianceCase);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  broadcast('analytics', getAnalytics());

  return res.status(200).json({
    success: true,
    message: delivery?.etherealMode
      ? 'Test email created successfully. This message was not delivered to the customer.'
      : delivery?.testMode
      ? 'RFI email accepted for delivery.'
      : 'RFI email accepted for delivery.',
    transaction,
    case: complianceCase,
    auditEntry,
    activityLogs: getTransactionActivityLogs(transaction.id),
    previewUrl: delivery?.etherealMode ? delivery.previewUrl : undefined,
    delivery: {
      provider: delivery?.etherealMode ? 'ethereal' : 'smtp',
      recipientSource,
      accepted: delivery?.delivery?.accepted || [],
      rejected: delivery?.delivery?.rejected || [],
      pending: delivery?.delivery?.pending || [],
      response: delivery?.delivery?.response || null,
      messageId: delivery?.delivery?.messageId || null,
    },
  });
});

console.log('Registered RFI route: POST /api/transactions/:id/rfi');

app.post('/api/transactions/:id/actions', (req, res) => {
  const transaction = findTransactionById(req.params.id);
  if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

  if (isAssessmentResolvedForServer(transaction)) {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }

  const actionType = req.body.actionType;
  const notes = String(req.body.notes || '').trim();
  if (!transactionActionTypes.includes(actionType)) {
    return res.status(400).json({ success: false, message: 'Invalid action type' });
  }
  if (!hasMeaningfulAnalystNotes(notes)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful explanation of at least 10 characters.' });
  }

  const { alert, complianceCase } = getAuditContextForTransaction(transaction);
  const currentAssessmentStatus = transaction.assessmentStatus || complianceCase?.status || 'New';
  if (actionType === 'CASE_ESCALATED' && currentAssessmentStatus === 'Escalated') {
    return res.status(409).json({ success: false, message: 'Case is already escalated' });
  }

  const actionConfig = {
    RFI_REQUESTED: {
      action: 'Request for Information',
      status: 'Waiting for Information',
      message: 'Request for information recorded.',
    },
    STR_FILED: {
      action: 'STR Filed',
      status: currentAssessmentStatus,
      message: 'STR filing recorded.',
    },
    CASE_ESCALATED: {
      action: 'Case Escalated',
      status: 'Escalated',
      message: 'Case escalated for senior review.',
    },
  }[actionType];

  transaction.assessmentStatus = actionConfig.status;
  transaction.reviewAction = actionType;
  transaction.updatedAt = new Date().toISOString();

  if (complianceCase && actionConfig.status !== currentAssessmentStatus) {
    complianceCase.status = actionConfig.status;
    complianceCase.updatedAt = transaction.updatedAt;
  }

  const auditEntry = logAudit(actionConfig.action, {
    actor: req.body.actor || 'Analyst',
    entityType: complianceCase ? 'Case' : 'Transaction',
    entityId: complianceCase?.id || transaction.id,
    transactionId: transaction.id,
    alertId: alert?.id || null,
    caseId: complianceCase?.id || null,
    companyId: transaction.companyId,
    companyName: transaction.companyName,
    message: actionConfig.message,
  });

  queueDbWrite(async () => {
    if (complianceCase) await database.updateCase(complianceCase);
  });

  broadcast('transactionUpdate', transaction);
  if (complianceCase) broadcast('caseUpdate', complianceCase);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  broadcast('analytics', getAnalytics());

  res.status(201).json({
    success: true,
    message: actionConfig.message,
    transaction,
    case: complianceCase,
    auditEntry,
    activityLogs: getTransactionActivityLogs(transaction.id),
  });
});

app.patch('/api/transactions/:id/resolve', (req, res) => {
  try {
    console.log('Resolve Assessment route reached', {
      transactionId: req.params.id,
      body: {
        finalRiskLevel: req.body.finalRiskLevel,
        decision: req.body.decision,
        resolutionReason: req.body.resolutionReason,
        analystNotesLength: String(req.body.analystNotes || '').length,
      },
    });

    const transaction = findTransactionById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const { alert, complianceCase } = getAuditContextForTransaction(transaction);
    if (
      transaction.finalRiskScore !== null
      && transaction.finalRiskScore !== undefined
      && transaction.finalRiskLevel
    ) {
      return res.status(409).json({ success: false, message: 'Assessment already resolved' });
    }
    if (complianceCase?.resolvedAt || complianceCase?.status === 'Resolved') {
      return res.status(409).json({ success: false, message: 'Assessment already resolved' });
    }

    const finalRiskLevel = req.body.finalRiskLevel;
    const decision = req.body.decision;
    const resolutionReason = String(req.body.resolutionReason || '').trim();
    const analystNotes = String(req.body.analystNotes || '').trim();

    if (!finalRiskLevels.includes(finalRiskLevel)) {
      return res.status(400).json({ success: false, message: 'Invalid final risk level' });
    }
    if (!assessmentDecisions.includes(decision)) {
      return res.status(400).json({ success: false, message: 'Invalid decision' });
    }
    if (!resolutionReason || !resolutionReasons.includes(resolutionReason)) {
      return res.status(400).json({ success: false, message: 'Resolution reason is required' });
    }
    if (!hasMeaningfulAnalystNotes(analystNotes)) {
      return res.status(400).json({ success: false, message: 'Please provide a meaningful explanation of at least 10 characters.' });
    }

    const finalRiskScore = getFinalRiskScore(finalRiskLevel);
    const resolvedAt = new Date().toISOString();

    transaction.finalRiskScore = finalRiskScore;
    transaction.finalRiskLevel = finalRiskLevel;
    transaction.decision = decision;
    transaction.resolutionReason = resolutionReason;
    transaction.analystNotes = analystNotes;
    transaction.resolvedAt = resolvedAt;

    if (complianceCase) {
      complianceCase.status = 'Resolved';
      complianceCase.decision = decision;
      complianceCase.resolutionReason = resolutionReason;
      complianceCase.analystNotes = analystNotes;
      complianceCase.resolvedAt = resolvedAt;
      complianceCase.updatedAt = resolvedAt;
    }

    logAudit('Final Risk Assigned', {
      actor: 'Operations Team',
      entityType: complianceCase ? 'Case' : 'Transaction',
      entityId: complianceCase?.id || transaction.id,
      transactionId: transaction.id,
      alertId: alert?.id || null,
      caseId: complianceCase?.id || null,
      companyId: transaction.companyId,
      companyName: transaction.companyName,
      message: `Final risk assigned as ${finalRiskLevel} with score ${finalRiskScore}.`,
    });

    logAudit('Assessment Resolved', {
      actor: 'Operations Team',
      entityType: complianceCase ? 'Case' : 'Transaction',
      entityId: complianceCase?.id || transaction.id,
      transactionId: transaction.id,
      alertId: alert?.id || null,
      caseId: complianceCase?.id || null,
      companyId: transaction.companyId,
      companyName: transaction.companyName,
      message: `Assessment resolved with decision ${decision} and reason ${resolutionReason}.`,
    });

    queueDbWrite(async () => {
      await database.saveTransaction(transaction);
      if (complianceCase) await database.updateCase(complianceCase);
      console.log('Resolve Assessment database update result', {
        transactionId: transaction.id,
        caseId: complianceCase?.id || null,
        savedTransactionFinalRisk: true,
        savedCaseResolution: Boolean(complianceCase),
      });
    });

    broadcast('transactionUpdate', transaction);
    if (complianceCase) broadcast('caseUpdate', complianceCase);
    broadcast('metrics', getMetrics());
    broadcast('charts', getCharts());
    broadcast('analytics', getAnalytics());

    return res.status(200).json({
      success: true,
      message: 'Assessment resolved successfully',
      transaction,
      case: complianceCase,
      activityLogs: getTransactionActivityLogs(transaction.id),
    });
  } catch (error) {
    console.error('Resolve Assessment failed', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to resolve assessment' });
  }
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
      transactionId: alert.transactionId,
      alertId: alert.id,
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
    const linkedAlert = alerts.find((alert) => alert.id === complianceCase.alertId);
    logAudit('Case Status Changed', {
      actor: complianceCase.owner,
      entityType: 'Case',
      entityId: complianceCase.id,
      transactionId: linkedAlert?.transactionId || null,
      alertId: complianceCase.alertId,
      caseId: complianceCase.id,
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

app.use('/api', (req, res) => {
  if (/^\/api\/transactions\/[^/]+\/rfi\/?$/.test(req.originalUrl)) {
    return res.status(404).json({
      success: false,
      message: 'RFI route not found.',
    });
  }

  res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
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
    console.log(`Compliance monitoring system running on http://localhost:${PORT}`);
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













