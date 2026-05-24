const express = require('express');
const path = require('path');
const {
  evaluateTransaction,
  companyRuleSets,
  riskBands,
  serializeCompanyRuleSets,
} = require('./src/complianceEngine');
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
const alertStatuses = ['Open', 'Investigating', 'Escalated', 'Closed', 'False Positive'];

const countries = ['Singapore', 'Malaysia', 'United States', 'Indonesia', 'Thailand', 'Vietnam', 'United Arab Emirates'];
const highRiskCountries = ['North Korea', 'Iran', 'Syria', 'Russia'];
const standardMerchantCategories = ['Fashion', 'Footwear', 'Leather Goods', 'Skincare', 'Makeup'];
const riskyMerchantCategories = ['Luxury Resale', 'Premium Bundle'];
const channels = ['Card Present', 'E-Commerce', 'Wallet', 'Bank Transfer', 'ATM'];
const customers = [
  { id: 'CUS-1001', name: 'Ava Lim', segment: 'Retail', kyc: 'Verified' },
  { id: 'CUS-1002', name: 'Noah Tan', segment: 'SME', kyc: 'Verified' },
  { id: 'CUS-1003', name: 'Maya Wong', segment: 'Private Client', kyc: 'Enhanced Due Diligence' },
  { id: 'CUS-1004', name: 'Ethan Koh', segment: 'Retail', kyc: 'Pending Review' },
  { id: 'CUS-1005', name: 'Sophia Chen', segment: 'Corporate', kyc: 'Verified' },
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
  const transaction = {
    id: id('TXN'),
    companyId: company.id,
    companyName: company.name,
    merchantType: company.merchantType,
    customerId: customer.id,
    customerName: customer.name,
    segment: customer.segment,
    kycStatus: customer.kyc,
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
    status: 'Screening',
    createdAt: new Date().toISOString(),
    ...overrides,
  };

  const result = evaluateTransaction(transaction, company.rules);
  transaction.riskScore = result.riskScore;
  transaction.riskBand = riskBands(result.riskScore);
  transaction.status = result.matchedRules.length ? 'Flagged' : 'Cleared';
  transaction.matchedRules = result.matchedRules;

  pushLimited(transactions, transaction);

  if (result.matchedRules.length) {
    const alert = {
      id: id('ALT'),
      transactionId: transaction.id,
      companyId: transaction.companyId,
      companyName: transaction.companyName,
      customerId: transaction.customerId,
      customerName: transaction.customerName,
      severity: transaction.riskBand,
      riskScore: transaction.riskScore,
      rules: result.matchedRules,
      status: 'Open',
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
      status: 'Triage',
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
  } else {
    queueDbWrite(() => database.saveTransaction(transaction));
  }

  broadcast('transaction', transaction);
  broadcast('metrics', getMetrics());
  broadcast('charts', getCharts());
  return transaction;
}

function getMetrics() {
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const highRisk = transactions.filter((txn) => ['High', 'Critical'].includes(txn.riskBand)).length;
  const openAlerts = alerts.filter((alert) => alert.status === 'Open').length;
  const activeAlerts = alerts.filter((alert) => !['Closed', 'False Positive'].includes(alert.status)).length;
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

  const alertStatus = alertStatuses.map((status) => ({
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


function renderPage(view, title, activePage) {
  return (req, res) => {
    res.render(view, { title, activePage });
  };
}

app.get('/', renderPage('dashboard', 'Compliance Dashboard', 'dashboard'));
app.get('/charts', renderPage('charts', 'Compliance Charts', 'charts'));
app.get('/alerts', renderPage('alerts', 'Alert Queue', 'alerts'));
app.get('/audit', renderPage('audit', 'Audit Log', 'audit'));
app.get('/cases', renderPage('cases', 'Investigation Cases', 'cases'));
app.get('/rules', renderPage('rules', 'Compliance Rules', 'rules'));

app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/charts.html', (req, res) => res.redirect(301, '/charts'));
app.get('/alerts.html', (req, res) => res.redirect(301, '/alerts'));
app.get('/audit.html', (req, res) => res.redirect(301, '/audit'));
app.get('/cases.html', (req, res) => res.redirect(301, '/cases'));
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
    amount,
    country: req.body.country || 'Singapore',
    merchantCategory: req.body.merchantCategory || 'Premium Bundle',
    channel: req.body.channel || 'Bank Transfer',
    direction: req.body.direction || 'Outbound',
    companyId: req.body.companyId || 'companyA',
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

  if (req.body.status && !alertStatuses.includes(req.body.status)) {
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
  res.json(alert);
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













