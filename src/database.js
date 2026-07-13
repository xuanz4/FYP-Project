require('dotenv').config();
const { calculateProfileRiskScore, normalizeRiskLevel } = require('./complianceEngine');

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
    `INSERT INTO companies (company_id, company_name, merchant_type, mcc_code, industry, industry_risk_score, merchant_risk_level, accent)
     VALUES (:id, :name, :merchantType, :mccCode, :industry, :industryRiskScore, :merchantRiskLevel, :accent)
     ON DUPLICATE KEY UPDATE
       company_name = VALUES(company_name),
       merchant_type = VALUES(merchant_type),
       mcc_code = VALUES(mcc_code),
       industry = VALUES(industry),
       industry_risk_score = VALUES(industry_risk_score),
       merchant_risk_level = VALUES(merchant_risk_level),
       accent = VALUES(accent)`,
    { ...company, merchantRiskLevel: normalizeRiskLevel(company.merchantRiskLevel) },
  );
}

async function upsertCustomer(customer) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO customers (customer_id, customer_name, email, account_type, authorised_contact_name, authorised_contact_email, segment, kyc_status, customer_risk_level)
     VALUES (:id, :name, :email, :accountType, :authorisedContactName, :authorisedContactEmail, :segment, :kyc, :customerRiskLevel)
     ON DUPLICATE KEY UPDATE
       customer_name = VALUES(customer_name),
       email = VALUES(email),
       account_type = VALUES(account_type),
       authorised_contact_name = VALUES(authorised_contact_name),
       authorised_contact_email = VALUES(authorised_contact_email),
       segment = VALUES(segment),
       kyc_status = VALUES(kyc_status),
       customer_risk_level = VALUES(customer_risk_level)`,
    { ...customer, customerRiskLevel: normalizeRiskLevel(customer.customerRiskLevel) },
  );
}

async function saveTransaction(transaction) {
  if (!enabled) return;

  await upsertCustomer({
    id: transaction.customerId,
    name: transaction.customerName,
    email: transaction.customerEmail,
    accountType: transaction.accountType || 'Individual',
    authorisedContactName: transaction.authorisedContactName || null,
    authorisedContactEmail: transaction.authorisedContactEmail || null,
    segment: transaction.segment,
    kyc: transaction.kycStatus,
    customerRiskLevel: transaction.customerRiskLevel,
  });

  await pool.execute(
    `INSERT INTO transactions (
      transaction_id, unique_transaction_id, company_id, customer_id, amount, currency, country,
      merchant_category, recent_company_transactions, card_spend_24h,
      near_threshold_count, low_value_burst_count, is_new_customer,
      usual_spend_below_100, channel, direction, counterparty_name,
      counterparty_country, payment_reference, screening_status, status,
      transaction_hour, operating_hours_triggered,
      mcc_risk_score, profile_risk_score, transaction_detection_score,
      initial_risk_score, initial_risk_level, final_risk_score, final_risk_level,
      risk_level, recommended_action, risk_score, risk_band, created_at
    ) VALUES (
      :id, :uniqueTransactionId, :companyId, :customerId, :amount, :currency, :country,
      :merchantCategory, :recentCompanyTransactions, :cardSpend24h,
      :nearThresholdCount, :lowValueBurstCount, :isNewCustomer,
      :usualSpendBelow100, :channel, :direction, :counterpartyName,
      :counterpartyCountry, :paymentReference, :screeningStatus, :status,
      :transactionHour, :operatingHoursTriggered,
      :mccRiskScore, :profileRiskScore, :transactionDetectionScore,
      :initialRiskScore, :initialRiskLevel, :finalRiskScore, :finalRiskLevel,
      :riskLevel, :recommendedAction, :riskScore, :riskBand, :createdAt
    )
    ON DUPLICATE KEY UPDATE
      amount = VALUES(amount),
      counterparty_name = VALUES(counterparty_name),
      counterparty_country = VALUES(counterparty_country),
      payment_reference = VALUES(payment_reference),
      screening_status = VALUES(screening_status),
      status = VALUES(status),
      transaction_hour = VALUES(transaction_hour),
      operating_hours_triggered = VALUES(operating_hours_triggered),
      mcc_risk_score = VALUES(mcc_risk_score),
      profile_risk_score = VALUES(profile_risk_score),
      transaction_detection_score = VALUES(transaction_detection_score),
      initial_risk_score = VALUES(initial_risk_score),
      initial_risk_level = VALUES(initial_risk_level),
      final_risk_score = VALUES(final_risk_score),
      final_risk_level = VALUES(final_risk_level),
      risk_level = VALUES(risk_level),
      recommended_action = VALUES(recommended_action),
      risk_score = VALUES(risk_score),
      risk_band = VALUES(risk_band)`,
    {
      ...transaction,
      isNewCustomer: transaction.isNewCustomer ? 1 : 0,
      usualSpendBelow100: transaction.usualSpendBelow100 ? 1 : 0,
      operatingHoursTriggered: transaction.operatingHoursTriggered ? 1 : 0,
      initialRiskScore: Number(transaction.initialRiskScore ?? transaction.riskScore) || 0,
      initialRiskLevel: transaction.initialRiskLevel || transaction.riskBand || transaction.riskLevel || 'Low',
      finalRiskScore: transaction.finalRiskScore ?? null,
      finalRiskLevel: transaction.finalRiskLevel || null,
      createdAt: toDate(transaction.createdAt),
    },
  );

  await pool.execute('DELETE FROM transaction_screening_matches WHERE transaction_id = ?', [transaction.id]);
  for (const match of transaction.screeningMatches || []) {
    await pool.execute(
      `INSERT INTO transaction_screening_matches (
        transaction_id, watchlist_id, watchlist_name, match_type, match_field,
        input_value, match_country, risk_level, match_score, reason
      ) VALUES (
        :transactionId, :watchlistId, :watchlistName, :matchType, :matchField,
        :inputValue, :matchCountry, :riskLevel, :matchScore, :reason
      )
      ON DUPLICATE KEY UPDATE
        match_score = VALUES(match_score),
        input_value = VALUES(input_value),
        reason = VALUES(reason)`,
      {
        transactionId: transaction.id,
        watchlistId: match.id,
        watchlistName: match.name,
        matchType: match.type,
        matchField: match.field,
        inputValue: match.input,
        matchCountry: match.country,
        riskLevel: match.risk,
        matchScore: match.score,
        reason: match.reason,
      },
    );
  }

  for (const rule of transaction.matchedRules || []) {
    await pool.execute(
      `INSERT INTO compliance_rules (
        rule_id, company_id, rule_name, risk_level, reason, weight, rule_type
      ) VALUES (
        :ruleId, :companyId, :ruleName, :riskLevel, :reason, :weight, :ruleType
      )
      ON DUPLICATE KEY UPDATE
        rule_name = VALUES(rule_name),
        risk_level = VALUES(risk_level),
        reason = VALUES(reason),
        weight = VALUES(weight)`,
      {
        ruleId: rule.id,
        companyId: transaction.companyId,
        ruleName: rule.name,
        riskLevel: rule.risk || transaction.riskBand,
        reason: rule.reason || rule.name,
        weight: rule.weight,
        ruleType: rule.id.startsWith('SCR-') ? 'screening_match' : rule.id.startsWith('PROFILE-') ? 'profile_risk' : rule.id.startsWith('TIME-') ? 'operating_hours' : 'runtime_rule',
      },
    );

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
      alert_id, transaction_id, primary_rule_id, grouped_count, company_id,
      customer_id, severity, risk_score, mcc_risk_score, profile_risk_score,
      transaction_detection_score, initial_risk_score, initial_risk_level,
      final_risk_score, final_risk_level, risk_level, recommended_action,
      alert_status, analyst, created_at,
      updated_at
    ) VALUES (
      :id, :transactionId, :primaryRuleId, :groupedCount, :companyId,
      :customerId, :severity, :riskScore, :mccRiskScore, :profileRiskScore,
      :transactionDetectionScore, :initialRiskScore, :initialRiskLevel,
      :finalRiskScore, :finalRiskLevel, :riskLevel, :recommendedAction,
      :status, :analyst, :createdAt,
      :updatedAt
    )
    ON DUPLICATE KEY UPDATE
      transaction_id = VALUES(transaction_id),
      grouped_count = VALUES(grouped_count),
      severity = VALUES(severity),
      risk_score = VALUES(risk_score),
      mcc_risk_score = VALUES(mcc_risk_score),
      profile_risk_score = VALUES(profile_risk_score),
      transaction_detection_score = VALUES(transaction_detection_score),
      initial_risk_score = VALUES(initial_risk_score),
      initial_risk_level = VALUES(initial_risk_level),
      final_risk_score = VALUES(final_risk_score),
      final_risk_level = VALUES(final_risk_level),
      risk_level = VALUES(risk_level),
      recommended_action = VALUES(recommended_action),
      alert_status = VALUES(alert_status),
      analyst = VALUES(analyst),
      updated_at = VALUES(updated_at)`,
    {
      ...alert,
      primaryRuleId: alert.primaryRuleId || null,
      groupedCount: alert.groupedCount || 1,
      mccRiskScore: Number(alert.mccRiskScore) || 0,
      profileRiskScore: Number(alert.profileRiskScore) || 0,
      transactionDetectionScore: Number(alert.transactionDetectionScore) || 0,
      initialRiskScore: Number(alert.initialRiskScore ?? alert.riskScore) || 0,
      initialRiskLevel: alert.initialRiskLevel || alert.severity || alert.riskLevel || 'Low',
      finalRiskScore: alert.finalRiskScore ?? null,
      finalRiskLevel: alert.finalRiskLevel || null,
      riskLevel: alert.riskLevel || alert.initialRiskLevel || alert.severity,
      recommendedAction: alert.recommendedAction || 'Allow',
      createdAt: toDate(alert.createdAt),
      updatedAt: toDate(alert.updatedAt),
    },
  );

  for (const transactionId of alert.transactionIds || [alert.transactionId]) {
    await pool.execute(
      `INSERT INTO alert_transaction_links (alert_id, transaction_id)
       VALUES (:alertId, :transactionId)
       ON DUPLICATE KEY UPDATE linked_at = linked_at`,
      {
        alertId: alert.id,
        transactionId,
      },
    );
  }
}

async function updateAlert(alert) {
  if (!enabled) return;

  await pool.execute(
    `UPDATE alerts
     SET alert_status = :status,
         analyst = :analyst,
         grouped_count = COALESCE(:groupedCount, grouped_count),
         risk_score = COALESCE(:riskScore, risk_score),
         mcc_risk_score = COALESCE(:mccRiskScore, mcc_risk_score),
          profile_risk_score = COALESCE(:profileRiskScore, profile_risk_score),
          transaction_detection_score = COALESCE(:transactionDetectionScore, transaction_detection_score),
          initial_risk_score = COALESCE(:initialRiskScore, initial_risk_score),
          initial_risk_level = COALESCE(:initialRiskLevel, initial_risk_level),
          final_risk_score = COALESCE(:finalRiskScore, final_risk_score),
          final_risk_level = COALESCE(:finalRiskLevel, final_risk_level),
          risk_level = COALESCE(:riskLevel, risk_level),
         recommended_action = COALESCE(:recommendedAction, recommended_action),
         severity = COALESCE(:severity, severity),
         transaction_id = COALESCE(:transactionId, transaction_id),
         updated_at = COALESCE(:updatedAt, updated_at)
     WHERE alert_id = :id`,
    {
      ...alert,
      groupedCount: alert.groupedCount || null,
      updatedAt: toDate(alert.updatedAt),
    },
  );

  for (const transactionId of alert.transactionIds || []) {
    await pool.execute(
      `INSERT INTO alert_transaction_links (alert_id, transaction_id)
       VALUES (:alertId, :transactionId)
       ON DUPLICATE KEY UPDATE linked_at = linked_at`,
      {
        alertId: alert.id,
        transactionId,
      },
    );
  }
}

async function saveCase(complianceCase) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO compliance_cases (
      case_id, alert_id, company_id, customer_id, summary, priority,
      case_status, owner, due_at, decision, resolution_reason,
      analyst_notes, resolved_at, updated_at
    ) VALUES (
      :id, :alertId, :companyId, :customerId, :summary, :priority,
      :status, :owner, :dueAt, :decision, :resolutionReason,
      :analystNotes, :resolvedAt, :updatedAt
    )
    ON DUPLICATE KEY UPDATE
      case_status = VALUES(case_status),
      owner = VALUES(owner),
      due_at = VALUES(due_at),
      decision = VALUES(decision),
      resolution_reason = VALUES(resolution_reason),
      analyst_notes = VALUES(analyst_notes),
      resolved_at = VALUES(resolved_at),
      updated_at = VALUES(updated_at)`,
    {
      ...complianceCase,
      owner: complianceCase.owner || 'Operations Team',
      dueAt: toDate(complianceCase.dueAt),
      decision: complianceCase.decision || null,
      resolutionReason: complianceCase.resolutionReason || null,
      analystNotes: complianceCase.analystNotes || null,
      resolvedAt: toDate(complianceCase.resolvedAt),
      updatedAt: toDate(complianceCase.updatedAt),
    },
  );
}

async function updateCase(complianceCase) {
  if (!enabled) return;

  await pool.execute(
    `UPDATE compliance_cases
     SET case_status = :status,
         owner = :owner,
         decision = :decision,
         resolution_reason = :resolutionReason,
         analyst_notes = :analystNotes,
         resolved_at = :resolvedAt,
         updated_at = :updatedAt
     WHERE case_id = :id`,
    {
      ...complianceCase,
      owner: complianceCase.owner || 'Operations Team',
      decision: complianceCase.decision || null,
      resolutionReason: complianceCase.resolutionReason || null,
      analystNotes: complianceCase.analystNotes || null,
      resolvedAt: toDate(complianceCase.resolvedAt),
      updatedAt: toDate(complianceCase.updatedAt),
    },
  );
}

async function saveAuditLog(entry) {
  if (!enabled) return;

  await pool.execute(
    `INSERT INTO audit_logs (
      audit_id, action, actor, entity_type, entity_id,
      transaction_id, alert_id, case_id, company_id,
      message, created_at
    ) VALUES (
      :id, :action, :actor, :entityType, :entityId,
      :transactionId, :alertId, :caseId, :companyId,
      :message, :createdAt
    )
    ON DUPLICATE KEY UPDATE message = VALUES(message)`,
    {
      ...entry,
      transactionId: entry.transactionId || null,
      alertId: entry.alertId || null,
      caseId: entry.caseId || null,
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
    `SELECT t.*, c.company_name, c.merchant_type, c.mcc_code, c.industry, c.industry_risk_score, c.merchant_risk_level, cu.customer_name, cu.email AS customer_email, cu.account_type, cu.authorised_contact_name, cu.authorised_contact_email, cu.segment, cu.kyc_status, cu.customer_risk_level
     FROM transactions t
     JOIN companies c ON t.company_id = c.company_id
     JOIN customers cu ON t.customer_id = cu.customer_id
     ORDER BY t.created_at DESC
     LIMIT 250`,
  );
  const transactionIds = transactionRows.map((row) => row.transaction_id);
  const matchedRules = await getMatchedRules(transactionIds);
  const screeningMatches = await getScreeningMatches(transactionIds);
  const transactionCaseOutcomes = await getCaseOutcomesByTransactionIds(transactionIds);
  const transactions = transactionRows.map((row) => {
    const caseOutcome = transactionCaseOutcomes[row.transaction_id] || {};
    return ({
    id: row.transaction_id,
    uniqueTransactionId: row.unique_transaction_id,
    companyId: row.company_id,
    companyName: row.company_name,
    merchantType: row.merchant_type,
    mccCode: row.mcc_code,
    industry: row.industry,
    industryRiskScore: row.industry_risk_score,
    merchantRiskLevel: normalizeRiskLevel(row.merchant_risk_level),
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    accountType: row.account_type || 'Individual',
    authorisedContactName: row.authorised_contact_name,
    authorisedContactEmail: row.authorised_contact_email,
    segment: row.segment,
    kycStatus: row.kyc_status,
    customerRiskLevel: normalizeRiskLevel(row.customer_risk_level),
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
    transactionHour: row.transaction_hour,
    operatingHoursTriggered: Boolean(row.operating_hours_triggered),
    channel: row.channel,
    direction: row.direction,
    counterpartyName: row.counterparty_name,
    counterpartyCountry: row.counterparty_country,
    paymentReference: row.payment_reference,
    screeningStatus: row.screening_status,
    screeningMatches: screeningMatches[row.transaction_id] || [],
    status: row.status,
    profileRiskScore: calculateProfileRiskScore({
      customerRiskLevel: row.customer_risk_level,
      merchantRiskLevel: row.merchant_risk_level,
    }),
    mccRiskScore: Number(row.mcc_risk_score ?? row.industry_risk_score ?? 0),
    transactionDetectionScore: Number(row.transaction_detection_score ?? 0),
    initialRiskScore: Number(row.initial_risk_score ?? row.risk_score ?? row.final_risk_score ?? 0),
    initialRiskLevel: row.initial_risk_level || row.risk_level || row.risk_band,
    finalRiskScore: row.final_risk_score === null || row.final_risk_score === undefined ? null : Number(row.final_risk_score),
    finalRiskLevel: row.final_risk_level || null,
    decision: caseOutcome.decision || null,
    resolutionReason: caseOutcome.resolutionReason || null,
    analystNotes: caseOutcome.analystNotes || null,
    resolvedAt: caseOutcome.resolvedAt || null,
    caseId: caseOutcome.caseId || null,
    caseStatus: caseOutcome.caseStatus || null,
    assessmentStatus: caseOutcome.caseStatus || null,
    riskLevel: row.risk_level || row.initial_risk_level || row.risk_band,
    recommendedAction: row.recommended_action,
    riskScore: Number(row.risk_score ?? row.final_risk_score ?? 0),
    riskBand: row.risk_band || row.risk_level,
    triggeredRules: matchedRules[row.transaction_id] || [],
    matchedRules: matchedRules[row.transaction_id] || [],
    createdAt: iso(row.created_at),
  });
  });

  const [alertRows] = await pool.query(
    `SELECT a.*, c.company_name, cu.customer_name
     FROM alerts a
     JOIN companies c ON a.company_id = c.company_id
     JOIN customers cu ON a.customer_id = cu.customer_id
     ORDER BY a.created_at DESC
    LIMIT 120`,
  );
  const alertIds = alertRows.map((row) => row.alert_id);
  const alertTransactionLinks = await getAlertTransactionLinks(alertIds);
  const alerts = alertRows.map((row) => ({
    id: row.alert_id,
    transactionId: row.transaction_id,
    transactionIds: alertTransactionLinks[row.alert_id] || [row.transaction_id],
    primaryRuleId: row.primary_rule_id,
    groupedCount: row.grouped_count,
    companyId: row.company_id,
    companyName: row.company_name,
    customerId: row.customer_id,
    customerName: row.customer_name,
    severity: row.severity,
    riskScore: row.risk_score,
    mccRiskScore: row.mcc_risk_score,
    profileRiskScore: row.profile_risk_score,
    transactionDetectionScore: row.transaction_detection_score,
    initialRiskScore: row.initial_risk_score ?? row.risk_score,
    initialRiskLevel: row.initial_risk_level ?? row.risk_level,
    finalRiskScore: row.final_risk_score,
    finalRiskLevel: row.final_risk_level,
    riskLevel: row.risk_level,
    recommendedAction: row.recommended_action,
    rules: matchedRules[row.transaction_id] || [],
    status: row.alert_status,
    analyst: row.analyst,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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
    owner: row.owner,
    decision: row.decision,
    resolutionReason: row.resolution_reason,
    analystNotes: row.analyst_notes,
    resolvedAt: iso(row.resolved_at),
    dueAt: iso(row.due_at),
    updatedAt: iso(row.updated_at),
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
    transactionId: row.transaction_id,
    alertId: row.alert_id,
    caseId: row.case_id,
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

async function getScreeningMatches(transactionIds) {
  if (!transactionIds.length) return {};

  const [rows] = await pool.query(
    `SELECT *
     FROM transaction_screening_matches
     WHERE transaction_id IN (?)`,
    [transactionIds],
  );

  return rows.reduce((summary, row) => {
    if (!summary[row.transaction_id]) summary[row.transaction_id] = [];
    summary[row.transaction_id].push({
      id: row.watchlist_id,
      name: row.watchlist_name,
      type: row.match_type,
      field: row.match_field,
      input: row.input_value,
      country: row.match_country,
      risk: row.risk_level,
      score: row.match_score,
      reason: row.reason,
    });
    return summary;
  }, {});
}

async function getAlertTransactionLinks(alertIds) {
  if (!alertIds.length) return {};

  const [rows] = await pool.query(
    `SELECT alert_id, transaction_id
     FROM alert_transaction_links
     WHERE alert_id IN (?)
     ORDER BY linked_at ASC`,
    [alertIds],
  );

  return rows.reduce((summary, row) => {
    if (!summary[row.alert_id]) summary[row.alert_id] = [];
    summary[row.alert_id].push(row.transaction_id);
    return summary;
  }, {});
}

async function getCaseOutcomesByTransactionIds(transactionIds) {
  if (!transactionIds.length) return {};

  const [rows] = await pool.query(
    `SELECT atl.transaction_id, cc.case_id, cc.case_status, cc.decision, cc.resolution_reason,
            cc.analyst_notes, cc.resolved_at
     FROM alert_transaction_links atl
     JOIN compliance_cases cc ON atl.alert_id = cc.alert_id
     WHERE atl.transaction_id IN (?)`,
    [transactionIds],
  );

  return rows.reduce((summary, row) => {
    summary[row.transaction_id] = {
      caseId: row.case_id,
      caseStatus: row.case_status,
      decision: row.decision,
      resolutionReason: row.resolution_reason,
      analystNotes: row.analyst_notes,
      resolvedAt: iso(row.resolved_at),
    };
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
  updateCase,
  updateAlert,
  upsertCompany,
};
