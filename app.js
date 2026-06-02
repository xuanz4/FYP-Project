const express = require('express');
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

const countries = ['Singapore', 'Malaysia', 'United States', 'Indonesia', 'Thailand', 'Vietnam', 'United Arab Emirates'];
const highRiskCountries = ['North Korea', 'Iran', 'Syria', 'Russia'];
const standardMerchantCategories = ['Fashion', 'Footwear', 'Leather Goods', 'Skincare', 'Makeup'];
const riskyMerchantCategories = ['Luxury Resale', 'Premium Bundle'];
const channels = ['Card Present', 'E-Commerce', 'Wallet', 'Bank Transfer', 'ATM'];
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

  const result = evaluateTransaction(transaction, company.rules);
  const screening = screenPayment(transaction);
  const matchedRules = [...result.matchedRules];
  if (screening.matches.length) {
    matchedRules.push({
      id: 'SCR-001',
      name: 'Payment or customer screening match',
      risk: screening.matches.some((match) => match.type === 'Sanctions') ? 'High' : 'Medium',
      reason: `${screening.matches[0].type} match on ${screening.matches[0].field}`,
      weight: screening.matches.some((match) => match.type === 'Sanctions') ? 65 : 40,
    });
  }

  transaction.screeningStatus = screening.status;
  transaction.screeningMatches = screening.matches;
  transaction.profileRiskScore = result.profileRiskScore;
  transaction.riskScore = Math.min(100, result.riskScore + matchedRules.filter((rule) => rule.id.startsWith('SCR-')).reduce((score, rule) => score + rule.weight, 0));
  transaction.riskBand = riskBands(transaction.riskScore);
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













