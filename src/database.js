require('dotenv').config();

let mysql;
try {
  mysql = require('mysql2/promise');
} catch (error) {
  mysql = null;
}

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'fyp_transaction_monitoring',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
};

let pool = null;
let enabled = false;

function isEnabled() {
  return enabled;
}

function toDate(value) {
  return value ? new Date(value) : null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function initDatabase() {
  if (!mysql) {
    console.warn('mysql2 is not installed. Running with in-memory data only.');
    return false;
  }

  try {
    pool = mysql.createPool(config);
    await pool.query('SELECT 1');
    enabled = true;
    console.log(`Connected to MySQL database "${config.database}".`);
    return true;
  } catch (error) {
    console.warn(`Database not connected: ${error.message}`);
    console.warn('Run FYP_Transaction_Monitoring.sql in MySQL, then set DB_USER/DB_PASSWORD if needed.');
    enabled = false;
    return false;
  }
}

async function upsertCompany(company) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO companies (company_id, company_name, merchant_type, accent)
     VALUES (:id, :name, :merchantType, :accent)
     ON DUPLICATE KEY UPDATE
       company_name = VALUES(company_name),
       merchant_type = VALUES(merchant_type),
       accent = VALUES(accent)`,
    company,
  );
}

async function upsertCustomer(customer) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO customers (customer_id, customer_name, segment, kyc_status)
     VALUES (:id, :name, :segment, :kyc)
     ON DUPLICATE KEY UPDATE
       customer_name = VALUES(customer_name),
       segment = VALUES(segment),
       kyc_status = VALUES(kyc_status)`,
    customer,
  );
}

async function saveTransaction(transaction) {
  if (!enabled) return;

  await upsertCustomer({
    id: transaction.customerId,
    name: transaction.customerName,
    segment: transaction.segment,
    kyc: transaction.kycStatus,
  });

  await pool.execute(
    `INSERT INTO transactions (
      transaction_id, company_id, customer_id, amount, currency, country,
      merchant_category, recent_company_transactions, card_spend_24h,
      near_threshold_count, low_value_burst_count, is_new_customer,
      usual_spend_below_100, channel, direction, status, risk_score,
      risk_band, created_at
    ) VALUES (
      :id, :companyId, :customerId, :amount, :currency, :country,
      :merchantCategory, :recentCompanyTransactions, :cardSpend24h,
      :nearThresholdCount, :lowValueBurstCount, :isNewCustomer,
      :usualSpendBelow100, :channel, :direction, :status, :riskScore,
      :riskBand, :createdAt
    )
    ON DUPLICATE KEY UPDATE
      amount = VALUES(amount),
      status = VALUES(status),
      risk_score = VALUES(risk_score),
      risk_band = VALUES(risk_band)`,
    {
      ...transaction,
      isNewCustomer: transaction.isNewCustomer ? 1 : 0,
      usualSpendBelow100: transaction.usualSpendBelow100 ? 1 : 0,
      createdAt: toDate(transaction.createdAt),
    },
  );

  for (const rule of transaction.matchedRules || []) {
    await pool.execute(
      `INSERT INTO transaction_matched_rules (transaction_id, rule_id, rule_weight)
       VALUES (:transactionId, :ruleId, :ruleWeight)
       ON DUPLICATE KEY UPDATE rule_weight = VALUES(rule_weight)`,
      {
        transactionId: transaction.id,
        ruleId: rule.id,
        ruleWeight: rule.weight,
      },
    );
  }
}

async function saveAlert(alert) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO alerts (
      alert_id, transaction_id, company_id, customer_id, severity,
      risk_score, alert_status, analyst, created_at
    ) VALUES (
      :id, :transactionId, :companyId, :customerId, :severity,
      :riskScore, :status, :analyst, :createdAt
    )
    ON DUPLICATE KEY UPDATE
      alert_status = VALUES(alert_status),
      analyst = VALUES(analyst)`,
    {
      ...alert,
      createdAt: toDate(alert.createdAt),
    },
  );
}

async function updateAlert(alert) {
  if (!enabled) return;

  await pool.execute(
    'UPDATE alerts SET alert_status = :status, analyst = :analyst WHERE alert_id = :id',
    alert,
  );
}

async function saveCase(complianceCase) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO compliance_cases (
      case_id, alert_id, company_id, customer_id, summary, priority,
      case_status, due_at
    ) VALUES (
      :id, :alertId, :companyId, :customerId, :summary, :priority,
      :status, :dueAt
    )
    ON DUPLICATE KEY UPDATE
      case_status = VALUES(case_status),
      due_at = VALUES(due_at)`,
    {
      ...complianceCase,
      dueAt: toDate(complianceCase.dueAt),
    },
  );
}

async function saveAuditLog(entry) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO audit_logs (
      audit_id, action, actor, entity_type, entity_id, company_id,
      message, created_at
    ) VALUES (
      :id, :action, :actor, :entityType, :entityId, :companyId,
      :message, :createdAt
    )
    ON DUPLICATE KEY UPDATE message = VALUES(message)`,
    {
      ...entry,
      createdAt: toDate(entry.createdAt),
    },
  );
}

async function loadSnapshot() {
  if (!enabled) {
    return {
      transactions: [],
      alerts: [],
      cases: [],
      auditLogs: [],
    };
  }

  const [transactionRows] = await pool.query(
    `SELECT t.*, c.company_name, c.merchant_type, cu.customer_name, cu.segment, cu.kyc_status
     FROM transactions t
     JOIN companies c ON t.company_id = c.company_id
     JOIN customers cu ON t.customer_id = cu.customer_id
     ORDER BY t.created_at DESC
     LIMIT 250`,
  );
  const transactionIds = transactionRows.map((row) => row.transaction_id);
  const matchedRules = await getMatchedRules(transactionIds);
  const transactions = transactionRows.map((row) => ({
    id: row.transaction_id,
    companyId: row.company_id,
    companyName: row.company_name,
    merchantType: row.merchant_type,
    customerId: row.customer_id,
    customerName: row.customer_name,
    segment: row.segment,
    kycStatus: row.kyc_status,
    amount: Number(row.amount),
    currency: row.currency,
    country: row.country,
    merchantCategory: row.merchant_category,
    recentCompanyTransactions: row.recent_company_transactions,
    cardSpend24h: Number(row.card_spend_24h),
    nearThresholdCount: row.near_threshold_count,
    lowValueBurstCount: row.low_value_burst_count,
    isNewCustomer: Boolean(row.is_new_customer),
    usualSpendBelow100: Boolean(row.usual_spend_below_100),
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    riskScore: row.risk_score,
    riskBand: row.risk_band,
    matchedRules: matchedRules[row.transaction_id] || [],
    createdAt: iso(row.created_at),
  }));

  const [alertRows] = await pool.query(
    `SELECT a.*, c.company_name, cu.customer_name
     FROM alerts a
     JOIN companies c ON a.company_id = c.company_id
     JOIN customers cu ON a.customer_id = cu.customer_id
     ORDER BY a.created_at DESC
     LIMIT 120`,
  );
  const alerts = alertRows.map((row) => ({
    id: row.alert_id,
    transactionId: row.transaction_id,
    companyId: row.company_id,
    companyName: row.company_name,
    customerId: row.customer_id,
    customerName: row.customer_name,
    severity: row.severity,
    riskScore: row.risk_score,
    rules: matchedRules[row.transaction_id] || [],
    status: row.alert_status,
    analyst: row.analyst,
    createdAt: iso(row.created_at),
  }));

  const [caseRows] = await pool.query(
    `SELECT cc.*, c.company_name, cu.customer_name
     FROM compliance_cases cc
     JOIN companies c ON cc.company_id = c.company_id
     JOIN customers cu ON cc.customer_id = cu.customer_id
     ORDER BY cc.created_at DESC
     LIMIT 80`,
  );
  const cases = caseRows.map((row) => ({
    id: row.case_id,
    alertId: row.alert_id,
    companyId: row.company_id,
    companyName: row.company_name,
    customerId: row.customer_id,
    customerName: row.customer_name,
    summary: row.summary,
    priority: row.priority,
    status: row.case_status,
    dueAt: iso(row.due_at),
  }));

  const [auditRows] = await pool.query(
    `SELECT al.*, c.company_name
     FROM audit_logs al
     LEFT JOIN companies c ON al.company_id = c.company_id
     ORDER BY al.created_at DESC
     LIMIT 200`,
  );
  const auditLogs = auditRows.map((row) => ({
    id: row.audit_id,
    action: row.action,
    actor: row.actor,
    entityType: row.entity_type,
    entityId: row.entity_id,
    companyId: row.company_id,
    companyName: row.company_name,
    message: row.message,
    createdAt: iso(row.created_at),
  }));

  return { transactions, alerts, cases, auditLogs };
}

async function getMatchedRules(transactionIds) {
  if (!transactionIds.length) return {};

  const [rows] = await pool.query(
    `SELECT tmr.transaction_id, cr.rule_id, cr.rule_name, cr.risk_level, cr.reason, tmr.rule_weight
     FROM transaction_matched_rules tmr
     JOIN compliance_rules cr ON tmr.rule_id = cr.rule_id
     WHERE tmr.transaction_id IN (?)`,
    [transactionIds],
  );

  return rows.reduce((summary, row) => {
    if (!summary[row.transaction_id]) summary[row.transaction_id] = [];
    summary[row.transaction_id].push({
      id: row.rule_id,
      name: row.rule_name,
      risk: row.risk_level,
      reason: row.reason,
      weight: row.rule_weight,
    });
    return summary;
  }, {});
}

module.exports = {
  initDatabase,
  isEnabled,
  loadSnapshot,
  saveAlert,
  saveAuditLog,
  saveCase,
  saveTransaction,
  updateAlert,
  upsertCompany,
};
