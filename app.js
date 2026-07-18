const express = require('express');
require('dotenv').config();
const path = require('path');
const session = require('express-session');
const database = require('./src/database');
const emailService = require('./src/services/emailService');
const { ensureMerchant, ingestTransaction } = require('./src/transactionIngestion');

// Single-file Express entry point. The small connection-status/live-refresh client script is
// served at GET /app.js (see the route near the bottom).
const app = express();
const PORT = process.env.PORT || 3000;
app.locals.emailService = emailService;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'transaction-monitor-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentRole = req.session.user?.role || null;
  next();
});

const clients = new Set();
const assessmentDecisions = ['Accepted', 'Rejected'];
const resolutionReasons = ['Legitimate Transaction', 'False Positive', 'Suspicious Activity', 'Insufficient Information', 'Other'];
const stroReferralReasons = [
  'Possible suspicious activity',
  'Strong screening evidence',
  'Unexplained transaction behaviour',
  'RFI response remains insufficient',
  'Other',
];
const escalationDestinations = ['Senior Analyst', 'STRO'];
const escalationReasons = [
  'Critical risk requires senior review',
  'Possible suspicious activity / STR consideration',
  'Strong screening evidence',
  'RFI response remains insufficient',
  'Complex transaction behaviour',
  'Other',
];
const strEvidenceOptions = [
  'Triggered monitoring rules',
  'Screening evidence',
  'Screening matches',
  'Customer profile risk',
  'Merchant profile risk',
  'Transaction behaviour',
  'RFI response',
  'Other',
];

function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function getRiskLevelFromScore(score) {
  if (score >= 70) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function parseFinalRiskScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  return score;
}

function addWorkingDays(startDate, days) {
  const result = new Date(startDate);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }

  return result;
}

function hasMeaningfulAnalystNotes(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 10) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
}

function hasMeaningfulText(value, minLength) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < minLength) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
}

function normalizeEvidence(value) {
  const items = Array.isArray(value) ? value : [value].filter(Boolean);
  return items
    .map((item) => String(item || '').trim())
    .filter((item) => strEvidenceOptions.includes(item));
}

function formatSqlDateTime(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

function buildTransactionSummary(transaction) {
  return [
    `Transaction ID: ${transaction.transaction_id || transaction.id || ''}`,
    `Transaction date: ${transaction.created_at || transaction.createdAt ? new Date(transaction.created_at || transaction.createdAt).toLocaleString('en-SG') : 'Not assigned'}`,
    `Amount: ${transaction.currency || 'SGD'} ${Number(transaction.amount || 0).toFixed(2)}`,
    `Direction: ${transaction.direction || 'Local card payment'}`,
    `Counterparty: ${transaction.counterparty || transaction.counterpartyName || transaction.merchant_name || transaction.companyName || 'Merchant'}`,
    `Counterparty country: ${transaction.counterparty_country || transaction.counterpartyCountry || 'Singapore'}`,
  ].join('\n');
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function slugForTestEmail(value, fallback) {
  const slug = String(value || fallback || 'recipient')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  return slug || fallback || 'recipient';
}

function generateEtherealTestRecipientEmail({ recipientName, transactionId }) {
  const recipientSlug = slugForTestEmail(recipientName, 'recipient').slice(0, 30);
  const transactionSlug = slugForTestEmail(transactionId, 'transaction').slice(0, 24);
  return `${recipientSlug}-${transactionSlug}@example.com`;
}

function selectRfiDeliveryRecipient({ savedEmail, recipientName, transactionId, accountType, isEtherealMode }) {
  const trimmedEmail = String(savedEmail || '').trim();
  if (trimmedEmail) {
    return {
      email: trimmedEmail,
      source: accountType === 'Organisation' ? 'saved-organisation-contact' : 'saved-individual',
      generated: false,
    };
  }
  if (isEtherealMode) {
    return {
      email: generateEtherealTestRecipientEmail({ recipientName, transactionId }),
      source: 'generated-test',
      generated: true,
    };
  }
  return {
    email: null,
    source: 'missing',
    generated: false,
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
  if (code === 'EMISSINGCONFIG') {
    return { message: 'Email delivery is not configured for this deployment.', code };
  }
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
  if (code === 'EDELIVERYNOTACCEPTED') {
    return { message: 'The email provider did not accept the RFI recipient.', code };
  }
  if (code === 'EPREVIEWUNAVAILABLE') {
    return { message: 'The test email was created but no preview URL was available.', code };
  }
  return { message: 'The RFI email could not be sent.', code };
}

function isEmailDevelopmentMode() {
  return String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase() === 'ethereal';
}

async function findDatabaseRfiContext(transactionId) {
  if (!database.isEnabled()) return null;

  try {
    const [rows] = await database.query(
      `SELECT t.transaction_id, t.amount, t.currency, t.created_at, t.action_status,
              co.company_name, cu.customer_name, cu.email AS customer_email,
              cu.account_type, cu.authorised_contact_name, cu.authorised_contact_email,
              cc.case_id, cc.case_status AS case_status,
              cc.assigned_role, cc.escalation_destination, sr.str_status
       FROM transactions t
       JOIN companies co ON t.company_id = co.company_id
       JOIN customers cu ON t.customer_id = cu.customer_id
       LEFT JOIN alert_transaction_links atl ON atl.transaction_id = t.transaction_id
       LEFT JOIN compliance_cases cc ON cc.alert_id = atl.alert_id
       LEFT JOIN str_reports sr ON sr.case_id = cc.case_id
       WHERE t.transaction_id = ?
       ORDER BY cc.created_at DESC
       LIMIT 1`,
      [transactionId],
    );
    if (rows[0]) {
      const row = rows[0];
      const accountType = row.account_type || 'Individual';
      return {
        schema: 'compliance',
        transactionId: row.transaction_id,
        amount: row.amount,
        currency: row.currency || 'SGD',
        createdAt: row.created_at,
        companyName: row.company_name || 'Customer Review Team',
        recipientName: accountType === 'Organisation'
          ? (row.authorised_contact_name || row.customer_name || 'Authorised Contact')
          : (row.customer_name || 'Customer'),
        recipientEmail: accountType === 'Organisation'
          ? row.authorised_contact_email
          : row.customer_email,
        accountType,
        caseId: row.case_id || null,
        currentStatus: row.case_status || row.action_status || 'New',
        assignedRole: row.assigned_role || null,
        escalationDestination: row.escalation_destination || null,
        strStatus: row.str_status || null,
      };
    }
  } catch (error) {
    // The role-based test schema does not have customers/companies tables.
  }

  const [rows] = await database.query(
    `SELECT t.transaction_id, t.amount, t.created_at, t.action_status,
            m.merchant_name, c.case_id, c.status AS case_status,
            c.assigned_role, c.escalation_destination, sr.str_status
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    schema: 'role',
    transactionId: row.transaction_id,
    amount: row.amount,
    currency: 'SGD',
    createdAt: row.created_at,
    companyName: row.merchant_name || 'Customer Review Team',
    recipientName: 'Customer',
    recipientEmail: null,
    accountType: 'Individual',
    caseId: row.case_id || null,
    currentStatus: row.case_status || row.action_status || 'New',
    assignedRole: row.assigned_role || null,
    escalationDestination: row.escalation_destination || null,
    strStatus: row.str_status || null,
  };
}

async function handleDatabaseRfiRequest(req, res) {
  if (!req.session?.user || !roleCanPerform(req.session.user.role, 'sendRfi')) {
    return forbidJson(res);
  }

  let context;
  try {
    await ensureStrWorkflowSchema();
    context = await findDatabaseRfiContext(req.params.id);
  } catch (error) {
    console.error('Unable to load database RFI context', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to load transaction details' });
  }

  if (!context) return res.status(404).json({ success: false, message: 'Transaction not found' });
  if (['Resolved', 'Dismissed as False Positive', 'STR Filed'].includes(context.currentStatus)) {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }
  if (req.session.user.role === 'STRO') {
    const routedToStro = context.assignedRole === 'STRO' || context.escalationDestination === 'STRO';
    const openStrStatus = ['Recommended', 'Draft', 'Pending Approval'].includes(context.strStatus);
    if (!routedToStro || !openStrStatus) {
      return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    }
  }

  const validationMessage = validateRfiRequestBody(req.body);
  if (validationMessage) {
    return res.status(400).json({ success: false, message: validationMessage });
  }
  const isEtherealMode = String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase() === 'ethereal';
  const recipient = selectRfiDeliveryRecipient({
    savedEmail: context.recipientEmail,
    recipientName: context.recipientName,
    transactionId: context.transactionId,
    accountType: context.accountType,
    isEtherealMode,
  });
  if (!recipient.email) {
    return res.status(400).json({ success: false, message: 'Saved recipient email is missing' });
  }
  if (!emailService.isValidEmail(recipient.email)) {
    return res.status(400).json({ success: false, message: 'Recipient email is missing or invalid' });
  }

  const sender = app.locals.emailService || emailService;
  let delivery;
  try {
    delivery = await sender.sendRfiEmail({
      to: recipient.email,
      recipientName: context.recipientName,
      companyName: context.companyName,
      transactionId: context.transactionId,
      transactionDate: new Date(context.createdAt).toLocaleString('en-SG'),
      currency: context.currency,
      amount: context.amount,
      subject: String(req.body.subject || '').trim(),
      informationRequested: String(req.body.informationRequested || '').trim(),
    });
  } catch (error) {
    console.error('RFI email service failure', {
      transactionId: context.transactionId,
      message: error.message,
    });
    const safeError = getSafeEmailError(error);
    return res.status(502).json({ success: false, ...safeError });
  }

  if (context.schema === 'compliance') {
    if (context.caseId) {
      await database.execute('UPDATE compliance_cases SET case_status = ?, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', ['Waiting for Information', context.caseId]);
    }
    await database.execute(
      `INSERT INTO audit_logs (audit_id, action, actor, entity_type, entity_id, transaction_id, case_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id('AUD'),
        req.session.user.role === 'STRO' ? 'Additional Information Requested by STRO' : 'Request for Information Sent',
        req.session?.user?.user_name || req.session?.user?.name || 'Analyst',
        context.caseId ? 'Case' : 'Transaction',
        context.caseId || context.transactionId,
        context.transactionId,
        context.caseId,
        req.session.user.role === 'STRO'
          ? 'Additional supporting information requested for STR review.'
          : delivery?.etherealMode
            ? 'Test RFI email created requesting supporting transaction information.'
            : 'RFI email sent requesting supporting transaction information.',
      ],
    );
  } else {
    if (context.caseId) {
      await database.execute('UPDATE cases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', ['Pending RFI', context.caseId]);
    }
    await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', ['Pending RFI', context.transactionId]);
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        id('AUD'),
        context.transactionId,
        req.session.user.role === 'STRO' ? 'Additional Information Requested by STRO' : 'Request for Information Sent',
        req.session?.user?.id || null,
        req.session.user.role === 'STRO'
          ? 'Additional supporting information requested for STR review.'
          : delivery?.etherealMode
            ? 'Test RFI email created requesting supporting transaction information.'
            : 'RFI email sent requesting supporting transaction information.',
      ],
    );
  }

  return res.status(200).json({
    success: true,
    provider: delivery?.etherealMode ? 'ethereal' : 'smtp',
    recipientSource: recipient.source,
    message: delivery?.etherealMode
      ? 'Test RFI email created successfully. No real email was delivered.'
      : 'RFI email accepted for delivery.',
    previewUrl: delivery?.etherealMode ? delivery.previewUrl : undefined,
    delivery: {
      provider: delivery?.etherealMode ? 'ethereal' : 'smtp',
      recipientSource: recipient.generated ? 'generated-test' : 'stored',
      accepted: delivery?.delivery?.accepted || [],
      rejected: delivery?.delivery?.rejected || [],
      pending: delivery?.delivery?.pending || [],
      response: delivery?.delivery?.response || null,
      messageId: delivery?.delivery?.messageId || null,
    },
  });
}

async function ensureDatabaseResolveColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN ('transactions', 'cases')
       AND COLUMN_NAME IN ('final_risk_score', 'final_risk_level', 'decision', 'resolution_reason', 'analyst_notes', 'resolved_at')`,
    [dbName],
  );
  const hasColumn = (table, column) => columns.some((row) => row.TABLE_NAME === table && row.COLUMN_NAME === column);

  if (!hasColumn('transactions', 'final_risk_score')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN final_risk_score INT NULL AFTER risk_level');
  }
  if (!hasColumn('transactions', 'final_risk_level')) {
    await database.execute("ALTER TABLE transactions ADD COLUMN final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL AFTER final_risk_score");
  }
  if (!hasColumn('cases', 'decision')) {
    await database.execute('ALTER TABLE cases ADD COLUMN decision VARCHAR(40) NULL AFTER notes');
  }
  if (!hasColumn('cases', 'resolution_reason')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolution_reason VARCHAR(120) NULL AFTER decision');
  }
  if (!hasColumn('cases', 'analyst_notes')) {
    await database.execute('ALTER TABLE cases ADD COLUMN analyst_notes TEXT NULL AFTER resolution_reason');
  }
  if (!hasColumn('cases', 'resolved_at')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolved_at DATETIME NULL AFTER analyst_notes');
  }

  const [caseStatusColumn] = await database.query(
    `SELECT COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases' AND COLUMN_NAME = 'status'
     LIMIT 1`,
    [dbName],
  );
  if (caseStatusColumn[0] && !caseStatusColumn[0].COLUMN_TYPE.includes("'Resolved'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }

  const [actionStatusColumn] = await database.query(
    `SELECT COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'action_status'
     LIMIT 1`,
    [dbName],
  );
  if (actionStatusColumn[0] && !actionStatusColumn[0].COLUMN_TYPE.includes("'Resolved'")) {
    await database.execute("ALTER TABLE transactions MODIFY action_status ENUM('None', 'Pending RFI', 'Pending Senior Review', 'STR Filed', 'Dismissed as False Positive', 'Escalated', 'Resolved') NOT NULL DEFAULT 'None'");
  }
}

async function ensureCaseAssignmentColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [tables] = await database.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
     LIMIT 1`,
    [dbName],
  );
  if (!tables[0]) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('due_at', 'status')`,
    [dbName],
  );
  const dueColumn = columns.find((row) => row.COLUMN_NAME === 'due_at');
  const statusColumn = columns.find((row) => row.COLUMN_NAME === 'status');

  if (!dueColumn) {
    await database.execute('ALTER TABLE cases ADD COLUMN due_at DATETIME NULL AFTER notes');
  }

  if (statusColumn && !statusColumn.COLUMN_TYPE.includes("'Under Review'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }
}

async function ensureStrWorkflowSchema() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  await ensureCaseAssignmentColumns();

  const [caseColumns] = await database.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('assigned_role', 'escalation_destination', 'referred_to_stro_at', 'referred_to_stro_by', 'status')`,
    [dbName],
  );
  const hasCaseColumn = (column) => caseColumns.some((row) => row.COLUMN_NAME === column);
  const statusColumn = caseColumns.find((row) => row.COLUMN_NAME === 'status');

  if (!hasCaseColumn('assigned_role')) {
    await database.execute('ALTER TABLE cases ADD COLUMN assigned_role VARCHAR(40) NULL AFTER assigned_to');
  }
  if (!hasCaseColumn('escalation_destination')) {
    await database.execute('ALTER TABLE cases ADD COLUMN escalation_destination VARCHAR(40) NULL AFTER assigned_role');
  }
  if (!hasCaseColumn('referred_to_stro_at')) {
    await database.execute('ALTER TABLE cases ADD COLUMN referred_to_stro_at DATETIME NULL AFTER due_at');
  }
  if (!hasCaseColumn('referred_to_stro_by')) {
    await database.execute('ALTER TABLE cases ADD COLUMN referred_to_stro_by VARCHAR(20) NULL AFTER referred_to_stro_at');
  }
  if (statusColumn && !statusColumn.COLUMN_TYPE.includes("'STR Filed'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }

  await database.execute(
    `CREATE TABLE IF NOT EXISTS str_reports (
      str_id VARCHAR(40) PRIMARY KEY,
      transaction_id VARCHAR(40) NOT NULL,
      case_id VARCHAR(40) NOT NULL,
      str_status ENUM('Recommended', 'Draft', 'Pending Approval', 'Filed', 'Not Required') NOT NULL DEFAULT 'Recommended',
      reference_number VARCHAR(80) NULL,
      reporting_reason TEXT NULL,
      suspicion_summary TEXT NULL,
      transaction_summary TEXT NULL,
      supporting_evidence TEXT NULL,
      stro_notes TEXT NULL,
      referral_reason VARCHAR(120) NULL,
      referral_summary TEXT NULL,
      senior_analyst_notes TEXT NULL,
      prepared_by VARCHAR(20) NULL,
      approved_by VARCHAR(20) NULL,
      filed_by VARCHAR(20) NULL,
      filing_date DATE NULL,
      filed_at DATETIME NULL,
      not_required_reason TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uniq_str_case (case_id),
      INDEX idx_str_transaction (transaction_id),
      INDEX idx_str_status (str_status)
    )`,
  );
}

async function handleDatabaseResolveRequest(req, res) {
  if (!req.session?.user || !roleCanPerform(req.session.user.role, 'resolveCase')) {
    return forbidJson(res);
  }

  let rows;
  try {
    await ensureDatabaseResolveColumns();
    [rows] = await database.query(
      `SELECT t.transaction_id, t.risk_score, t.risk_level, t.status, t.action_status,
              t.final_risk_score, t.final_risk_level,
              c.case_id, c.status AS case_status, c.resolved_at
       FROM transactions t
       LEFT JOIN cases c ON c.transaction_id = t.transaction_id
       WHERE t.transaction_id = ?
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [req.params.id],
    );
  } catch (error) {
    console.error('Unable to load database resolve context', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to load transaction details' });
  }

  const row = rows[0];
  if (!row) return res.status(404).json({ success: false, message: 'Transaction not found' });

  const currentStatus = row.case_status || row.action_status || 'Open';
  if (req.session.user.role === 'Analyst' && (currentStatus === 'Escalated' || currentStatus === 'Pending Senior Review' || row.risk_level === 'Critical')) {
    return forbidJson(res);
  }
  if (row.final_risk_score !== null && row.final_risk_score !== undefined && row.final_risk_level) {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }
  if (row.resolved_at || currentStatus === 'Resolved') {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }

  const finalRiskScore = parseFinalRiskScore(req.body.finalRiskScore);
  if (finalRiskScore === null) {
    return res.status(400).json({ success: false, message: 'Final risk score must be a whole number from 0 to 100' });
  }
  const finalRiskLevel = getRiskLevelFromScore(finalRiskScore);
  const decision = req.body.decision;
  const resolutionReason = String(req.body.resolutionReason || '').trim();
  const analystNotes = String(req.body.analystNotes || '').trim();
  if (!assessmentDecisions.includes(decision)) {
    return res.status(400).json({ success: false, message: 'Invalid decision' });
  }
  if (!resolutionReason || !resolutionReasons.includes(resolutionReason)) {
    return res.status(400).json({ success: false, message: 'Resolution reason is required' });
  }
  if (!hasMeaningfulAnalystNotes(analystNotes)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful explanation of at least 10 characters.' });
  }
  if (resolutionReason === 'False Positive' && decision !== 'Accepted') {
    return res.status(400).json({ success: false, message: 'False Positive resolutions must use the Accepted decision' });
  }

  const resolvedAtSql = new Date();
  const nextStatus = 'Resolved';

  await database.execute(
    `UPDATE transactions
     SET final_risk_score = ?, final_risk_level = ?, action_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = ?`,
    [finalRiskScore, finalRiskLevel, nextStatus, row.transaction_id],
  );
  if (row.case_id) {
    await database.execute(
      `UPDATE cases
       SET status = ?, decision = ?, resolution_reason = ?, analyst_notes = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [nextStatus, decision, resolutionReason, analystNotes, resolvedAtSql, row.case_id],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'),
      row.transaction_id,
      'Final Risk Assigned',
      req.session.user.id,
      `Final risk assigned as ${finalRiskLevel} with score ${finalRiskScore}.`,
    ],
  );
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'),
      row.transaction_id,
      'Assessment Resolved',
      req.session.user.id,
      `Assessment resolved with decision ${decision} and reason ${resolutionReason}.`,
    ],
  );

  return res.status(200).json({
    success: true,
    message: 'Assessment resolved successfully',
    transaction: {
      transaction_id: row.transaction_id,
      risk_score: row.risk_score,
      risk_level: row.risk_level,
      finalRiskScore,
      finalRiskLevel,
      decision,
      resolutionReason,
      analystNotes,
      resolvedAt: resolvedAtSql ? resolvedAtSql.toISOString() : null,
    },
    case: row.case_id ? {
      case_id: row.case_id,
      status: nextStatus,
      decision,
      resolutionReason,
      analystNotes,
      resolvedAt: resolvedAtSql ? resolvedAtSql.toISOString() : null,
    } : null,
  });
}

function roleHomePath(role) {
  return {
    Admin: '/admin',
    Analyst: '/analyst',
    'Senior Analyst': '/senior-analyst',
    STRO: '/stro',
  }[role] || '/login';
}

function activePageForRole(role) {
  return {
    Admin: 'admin',
    Analyst: 'analyst',
    'Senior Analyst': 'senior-analyst',
    STRO: 'stro',
  }[role] || 'analyst';
}

function authRedirect(req, res, next) {
  const publicPaths = [
    '/login',
    '/auth/login',
    '/logout',
    '/styles.css',
    '/app.js',
    '/images',
  ];

  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (publicPaths.some((pathPrefix) => req.path === pathPrefix || req.path.startsWith(`${pathPrefix}/`))) {
    return next();
  }

  if (!req.session.user) {
    return res.redirect('/login');
  }

  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden');
    }
    return next();
  };
}

function roleCanPerform(role, action) {
  const permissions = {
    sendRfi: ['Analyst', 'Senior Analyst', 'STRO'],
    escalateCase: ['Analyst', 'Senior Analyst'],
    resolveCase: ['Analyst', 'Senior Analyst'],
    fileStr: ['STRO'],
    manageRules: ['Admin'],
  };
  return (permissions[action] || []).includes(role);
}

function forbidJson(res) {
  return res.status(403).json({
    success: false,
    message: 'You do not have permission to perform this action.',
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  return next();
}

function pageNumber(value) {
  const page = Number(value || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function pageLimit(value, fallback = 15) {
  const limit = Number(value || fallback);
  if (!Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, 25);
}

function paginationMeta(req, total, fallbackLimit = 15) {
  const page = pageNumber(req.query.page);
  const limit = pageLimit(req.query.limit, fallbackLimit);
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    offset: (page - 1) * limit,
  };
}

function analystStatusLabel(status) {
  return {
    Open: 'New',
    'Pending RFI': 'Waiting for Information',
    'Pending Senior Review': 'Escalated',
    Escalated: 'Escalated',
    'STR Filed': 'Resolved',
    'Dismissed as False Positive': 'Resolved',
    Resolved: 'Resolved',
    'Under Review': 'Under Review',
  }[status] || status || 'New';
}

async function ensureAnalystListSchema() {
  await ensureDatabaseResolveColumns();
  await ensureStrWorkflowSchema();
}

function appendWhere(where, values, clause, value) {
  if (value === undefined || value === null || value === '') return;
  where.push(clause);
  values.push(value);
}

function analystTransactionBaseSelect() {
  return `SELECT t.transaction_id, t.merchant_id, t.amount, t.transaction_code,
                 t.scheme, t.issuer_country, t.entry_mode, t.txn_time,
                 t.risk_score, t.risk_level, t.status, t.action_status,
                 t.created_at, t.updated_at,
                 m.merchant_name, m.mcc_code,
                 COUNT(DISTINCT tmr.rule_id) AS rules_count,
                 c.case_id, c.status AS case_status, c.assigned_to, c.assigned_role,
                 c.escalation_destination, c.due_at, c.decision,
                 u.user_name AS assigned_user_name,
                 sr.str_status
          FROM transactions t
          LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
          LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
          LEFT JOIN cases c ON c.transaction_id = t.transaction_id
          LEFT JOIN users u ON u.user_id = c.assigned_to
          LEFT JOIN str_reports sr ON sr.case_id = c.case_id`;
}

function analystGroupBy() {
  return `GROUP BY t.transaction_id, t.merchant_id, t.amount, t.transaction_code,
                  t.scheme, t.issuer_country, t.entry_mode, t.txn_time,
                  t.risk_score, t.risk_level, t.status, t.action_status,
                  t.created_at, t.updated_at, m.merchant_name, m.mcc_code,
                  c.case_id, c.status, c.assigned_to, c.assigned_role,
                  c.escalation_destination, c.due_at, c.decision,
                  u.user_name, sr.str_status`;
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

async function loadAnalystTransactions(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  // Excludes the retired demo merchants (MERCH-A/B/C) - their old randomly-generated
  // transactions can't be deleted (audit_logs is append-only) but shouldn't clutter the live feed.
  const where = ["t.merchant_id NOT IN ('MERCH-A', 'MERCH-B', 'MERCH-C')"];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 't.status = ?', filters.transactionStatus);
  appendWhere(where, values, 't.merchant_id = ?', filters.merchantId);
  if (filters.q) {
    where.push('(t.transaction_id LIKE ? OR t.transaction_code LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `${analystTransactionBaseSelect()}
     ${whereSql}
     ${analystGroupBy()}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

function queueWhereAndValues(filters) {
  const where = [
    "t.merchant_id NOT IN ('MERCH-A', 'MERCH-B', 'MERCH-C')",
    "(t.status = 'Flagged' OR t.action_status <> 'None' OR c.case_id IS NOT NULL)",
    "NOT (t.status = 'Cleared' AND t.risk_level = 'Low' AND c.case_id IS NULL)",
    "(c.status IS NULL OR c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed'))",
  ];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 'c.assigned_to = ?', filters.assignedTo);
  appendWhere(where, values, 'c.decision = ?', filters.decision);
  if (filters.dueStatus === 'overdue') where.push('c.due_at IS NOT NULL AND c.due_at < NOW()');
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(t.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  return { where, values };
}

function queueOrder(sort) {
  const sortMap = {
    created: 't.created_at DESC',
    due: 'c.due_at IS NULL ASC, c.due_at ASC',
    score: 't.risk_score DESC',
    rules: 'rules_count DESC',
  };
  return sortMap[sort] || `(c.due_at IS NOT NULL AND c.due_at < NOW()) DESC,
    t.risk_level = 'Critical' DESC,
    c.status = 'Escalated' DESC,
    c.status = 'Pending RFI' DESC,
    t.risk_level = 'High' DESC,
    t.created_at ASC`;
}

async function loadAnalystQueue(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  const { where, values } = queueWhereAndValues(filters);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT t.transaction_id) AS total
     FROM transactions t
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `${analystTransactionBaseSelect()}
     ${whereSql}
     ${analystGroupBy()}
     ORDER BY ${queueOrder(filters.sort)}
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [summaryRows] = await database.query(
    `SELECT
       SUM(t.risk_level = 'Critical') AS critical,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       SUM(c.assigned_to IS NULL) AS unassigned,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting
     FROM transactions t
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     WHERE ${queueWhereAndValues({}).where.join(' AND ')}`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadAnalystCases(req) {
  await ensureAnalystListSchema();
  const filters = analystFiltersFromQuery(req.query);
  const where = ["t.merchant_id NOT IN ('MERCH-A', 'MERCH-B', 'MERCH-C')"];
  const values = [];
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 'c.assigned_role = ?', filters.assignedRole);
  appendWhere(where, values, 'c.assigned_to = ?', filters.assignedTo);
  appendWhere(where, values, 'c.escalation_destination = ?', filters.escalatedTo);
  appendWhere(where, values, 'c.decision = ?', filters.decision);
  if (filters.dueStatus === 'overdue') where.push("c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')");
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(c.case_id LIKE ? OR c.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM cases c JOIN transactions t ON t.transaction_id = c.transaction_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
            c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
            u.user_name AS assigned_user_name, t.amount, t.risk_score, t.risk_level,
            t.status AS transaction_status, t.action_status, m.merchant_name, m.mcc_code,
            COUNT(DISTINCT tmr.rule_id) AS rules_count, sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users u ON u.user_id = c.assigned_to
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     GROUP BY c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
              c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
              u.user_name, t.amount, t.risk_score, t.risk_level, t.status, t.action_status,
              m.merchant_name, m.mcc_code, sr.str_status
     ORDER BY c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') ASC,
              (c.due_at IS NOT NULL AND c.due_at < NOW()) DESC,
              c.status = 'Pending RFI' DESC,
              c.status = 'Escalated' DESC,
              t.risk_level = 'Critical' DESC,
              t.risk_level = 'High' DESC,
              c.created_at ASC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [summaryRows] = await database.query(
    `SELECT
       SUM(c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(c.escalation_destination = 'Senior Analyst') AS senior,
       SUM(c.escalation_destination = 'STRO') AS stro,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue
     FROM cases c`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadAnalystAudit(req) {
  const filters = analystFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'al.action = ?', String(req.query.actionType || '').trim());
  appendWhere(where, values, 'al.user_id = ?', String(req.query.userId || '').trim());
  appendWhere(where, values, 'u.user_role = ?', String(req.query.userRole || '').trim());
  if (req.query.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(req.query.dateFrom); }
  if (req.query.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(req.query.dateTo); }
  if (filters.q) {
    where.push('(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  return { rows, actions, users, filters, pagination };
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
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
            c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
            assigned.user_name AS assigned_user_name, creator.user_name AS created_by_name,
            creator.user_role AS created_by_role, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role,
            t.amount, t.risk_score, t.risk_level, t.status AS transaction_status, t.action_status,
            m.merchant_name, m.mcc_code, COUNT(DISTINCT tmr.rule_id) AS rules_count,
            sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users assigned ON assigned.user_id = c.assigned_to
     LEFT JOIN users creator ON creator.user_id = c.created_by
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN transaction_matched_rules tmr ON tmr.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     GROUP BY c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.assigned_role,
              c.escalation_destination, c.status, c.decision, c.due_at, c.created_at, c.updated_at,
              assigned.user_name, creator.user_name, creator.user_role, referred.user_name,
              referred.user_role, t.amount, t.risk_score, t.risk_level, t.status, t.action_status,
              m.merchant_name, m.mcc_code, sr.str_status
     ORDER BY ${seniorCaseOrder(filters.sort)}
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const baseWhere = seniorCaseWhereAndValues({}).where.join(' AND ');
  const [summaryRows] = await database.query(
    `SELECT
       SUM(c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS pending_review,
       SUM(c.assigned_to = ?) AS assigned_to_me,
       SUM(c.assigned_to IS NULL) AS unassigned,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(c.escalation_destination = 'STRO') AS referred_to_stro,
       SUM(c.status IN ('Pending Senior Review', 'Under Review', 'Escalated') AND (c.escalation_destination IS NULL OR c.escalation_destination <> 'STRO')) AS ready_for_stro
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE ${baseWhere}`,
    [req.session.user.id],
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

const seniorAuditDefaultActions = [
  'Case Escalated to Senior Analyst',
  'Case Assigned',
  'Request for Information Sent',
  'Case Referred to STRO',
  'STR Recommended',
  'Final Risk Assigned',
  'Assessment Resolved',
  'Additional Information Requested by STRO',
];

async function loadSeniorAudit(req) {
  const filters = seniorFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.scope !== 'all') {
    where.push(`al.action IN (${seniorAuditDefaultActions.map(() => '?').join(', ')})`);
    values.push(...seniorAuditDefaultActions);
  }
  appendWhere(where, values, 'al.action = ?', filters.actionType);
  appendWhere(where, values, 'al.user_id = ?', filters.userId);
  appendWhere(where, values, 'u.user_role = ?', filters.userRole);
  if (filters.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(filters.dateTo); }
  if (filters.q) {
    where.push('(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  return { rows, actions, users, filters, pagination };
}

function stroFiltersFromQuery(query) {
  return {
    ...seniorFiltersFromQuery(query),
    strStatus: String(query.strStatus || '').trim(),
    referredBy: String(query.referredBy || '').trim(),
    preparedBy: String(query.preparedBy || '').trim(),
    filingDate: String(query.filingDate || '').trim(),
  };
}

function stroCaseWhereAndValues(filters = {}) {
  const where = ["(c.escalation_destination = 'STRO' OR c.assigned_role = 'STRO' OR sr.str_status IS NOT NULL)"];
  const values = [];
  appendWhere(where, values, 'sr.str_status = ?', filters.strStatus);
  appendWhere(where, values, 'c.status = ?', filters.assessmentStatus);
  appendWhere(where, values, 't.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'c.referred_to_stro_by = ?', filters.referredBy);
  if (filters.assignmentStatus === 'assigned') where.push('c.assigned_to IS NOT NULL');
  if (filters.assignmentStatus === 'unassigned') where.push('c.assigned_to IS NULL');
  if (filters.dueStatus === 'overdue') where.push("c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')");
  if (filters.dueStatus === 'notAssigned') where.push('c.due_at IS NULL');
  if (filters.q) {
    where.push('(c.case_id LIKE ? OR c.transaction_id LIKE ? OR m.merchant_name LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  return { where, values };
}

async function loadStroCases(req) {
  await ensureAnalystListSchema();
  const filters = stroFiltersFromQuery(req.query);
  const { where, values } = stroCaseWhereAndValues(filters);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await database.query(
    `SELECT COUNT(DISTINCT c.case_id) AS total
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT c.case_id, c.transaction_id, c.assigned_to, c.assigned_role, c.status,
            c.escalation_destination, c.due_at, c.created_at, c.updated_at,
            assigned.user_name AS assigned_user_name, referred.user_name AS referred_by_user_name,
            referred.user_role AS referred_by_user_role, t.amount, t.risk_score, t.risk_level,
            m.merchant_name, m.mcc_code, sr.str_status
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN users assigned ON assigned.user_id = c.assigned_to
     LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     ${whereSql}
     ORDER BY c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed') ASC,
              (c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) DESC,
              c.status = 'Pending RFI' DESC,
              sr.str_status = 'Pending Approval' DESC,
              sr.str_status = 'Draft' DESC,
              sr.str_status = 'Recommended' DESC,
              c.created_at ASC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const baseWhere = stroCaseWhereAndValues({}).where.join(' AND ');
  const [summaryRows] = await database.query(
    `SELECT
       SUM(sr.str_status = 'Recommended') AS recommended,
       SUM(sr.str_status = 'Draft') AS draft,
       SUM(sr.str_status = 'Pending Approval') AS pending_approval,
       SUM(c.status = 'Pending RFI') AS waiting,
       SUM(sr.str_status = 'Filed') AS filed,
       SUM(c.due_at IS NOT NULL AND c.due_at < NOW() AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS overdue,
       COUNT(DISTINCT c.case_id) AS referred
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE ${baseWhere}`,
  );
  return { rows, summary: summaryRows[0] || {}, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

async function loadStroReports(req) {
  await ensureAnalystListSchema();
  const filters = stroFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'sr.str_status = ?', filters.strStatus);
  appendWhere(where, values, 'sr.prepared_by = ?', filters.preparedBy);
  appendWhere(where, values, 'sr.filing_date = ?', filters.filingDate);
  if (filters.q) {
    where.push('(sr.reference_number LIKE ? OR sr.case_id LIKE ? OR sr.transaction_id LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM str_reports sr ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 15);
  const [rows] = await database.query(
    `SELECT sr.str_id, sr.reference_number, sr.case_id, sr.transaction_id, sr.str_status,
            sr.prepared_by, sr.approved_by, sr.filed_by, sr.filing_date, sr.created_at, sr.updated_at,
            prepared.user_name AS prepared_by_name, approved.user_name AS approved_by_name
     FROM str_reports sr
     LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
     LEFT JOIN users approved ON approved.user_id = sr.approved_by
     ${whereSql}
     ORDER BY sr.str_status = 'Filed' ASC, COALESCE(sr.updated_at, sr.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination, filterOptions: await getAnalystFilterOptions() };
}

const stroAuditDefaultActions = [
  'Case Referred to STRO',
  'STR Recommended',
  'STR Draft Saved',
  'STR Submitted for Approval',
  'STR Filed',
  'STR Marked Not Required',
  'Additional Information Requested by STRO',
];

async function loadStroAudit(req) {
  const filters = stroFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.scope !== 'all') {
    where.push(`al.action IN (${stroAuditDefaultActions.map(() => '?').join(', ')})`);
    values.push(...stroAuditDefaultActions);
  }
  appendWhere(where, values, 'al.action = ?', filters.actionType);
  appendWhere(where, values, 'al.user_id = ?', filters.userId);
  appendWhere(where, values, 'u.user_role = ?', filters.userRole);
  if (filters.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(filters.dateTo); }
  if (filters.q) {
    where.push('(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?)');
    values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const total = Number(countRows[0]?.total || 0);
  const pagination = paginationMeta(req, total, 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  return { rows, actions, users, filters, pagination };
}

function adminFiltersFromQuery(query) {
  return {
    role: String(query.role || '').trim(),
    status: String(query.status || '').trim(),
    industry: String(query.industry || '').trim(),
    mcc: String(query.mcc || '').trim(),
    riskLevel: String(query.riskLevel || '').trim(),
    ruleType: String(query.ruleType || '').trim(),
    merchantId: String(query.merchantId || '').trim(),
    actionType: String(query.actionType || '').trim(),
    userId: String(query.userId || '').trim(),
    userRole: String(query.userRole || '').trim(),
    entityType: String(query.entityType || '').trim(),
    dateFrom: String(query.dateFrom || '').trim(),
    dateTo: String(query.dateTo || '').trim(),
    q: String(query.q || '').trim(),
  };
}

async function loadAdminUsers(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'user_role = ?', filters.role);
  if (filters.status === 'active') where.push('is_active = 1');
  if (filters.status === 'inactive') where.push('is_active = 0');
  if (filters.q) { where.push('(user_id LIKE ? OR user_name LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT user_id, user_name, user_role, is_active FROM users ${whereSql} ORDER BY user_name ASC LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination };
}

async function loadAdminMerchants(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.status === 'active') where.push('is_active = 1');
  if (filters.status === 'inactive') where.push('is_active = 0');
  appendWhere(where, values, 'industry = ?', filters.industry);
  appendWhere(where, values, 'mcc_code = ?', filters.mcc);
  if (filters.q) { where.push('(merchant_id LIKE ? OR merchant_name LIKE ? OR industry LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM merchants ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT merchant_id, merchant_name, merchant_mid, merchant_country, mcc_code, industry, mcc_risk_score, risk_tier, is_active FROM merchants ${whereSql} ORDER BY merchant_name ASC LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [industries] = await database.query('SELECT DISTINCT industry FROM merchants ORDER BY industry ASC');
  const [mccs] = await database.query('SELECT DISTINCT mcc_code FROM merchants ORDER BY mcc_code ASC');
  return { rows, industries, mccs, filters, pagination };
}

async function loadAdminRules(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'cr.merchant_id = ?', filters.merchantId);
  appendWhere(where, values, 'cr.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'cr.rule_type = ?', filters.ruleType);
  if (filters.status === 'active') where.push('cr.is_active = 1');
  if (filters.status === 'inactive') where.push('cr.is_active = 0');
  if (filters.q) { where.push('(cr.rule_id LIKE ? OR cr.rule_name LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM compliance_rules cr ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT cr.rule_id, cr.merchant_id, cr.rule_name, cr.risk_level, cr.reason, cr.weight,
            cr.amount_threshold, cr.count_threshold, cr.rule_type, cr.is_active,
            m.merchant_name
     FROM compliance_rules cr
     LEFT JOIN merchants m ON m.merchant_id = cr.merchant_id
     ${whereSql}
     ORDER BY cr.rule_name ASC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [merchants] = await database.query('SELECT merchant_id, merchant_name FROM merchants WHERE is_active = 1 ORDER BY merchant_name ASC');
  const [ruleTypes] = await database.query('SELECT DISTINCT rule_type FROM compliance_rules ORDER BY rule_type ASC');
  return { rows, merchants, ruleTypes, filters, pagination };
}

async function loadAdminAudit(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'al.action = ?', filters.actionType);
  appendWhere(where, values, 'al.user_id = ?', filters.userId);
  appendWhere(where, values, 'u.user_role = ?', filters.userRole);
  appendWhere(where, values, 'al.entity_type = ?', filters.entityType);
  if (filters.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(filters.dateTo); }
  if (filters.q) { where.push('(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  const [entities] = await database.query('SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type ASC');
  return { rows, actions, users, entities, filters, pagination };
}

function renderLogin(req, res, error = null) {
  if (req.session.user) {
    return res.redirect(roleHomePath(req.session.user.role));
  }

  return res.render('login', {
    title: 'Login',
    layout: 'login',
    error,
  });
}

app.use(authRedirect);

app.get('/login', (req, res) => renderLogin(req, res));

app.post('/auth/login', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const password = String(req.body.password || '');
    if (!userId || !password) {
      return renderLogin(req, res, 'User ID and password are required.');
    }

    const [rows] = await database.query(
      `SELECT user_id, user_name, user_role, is_active
       FROM users
       WHERE user_id = ?
         AND password = SHA2(?, 256)
         AND is_active = 1
       LIMIT 1`,
      [userId, password],
    );

    const user = rows[0];
    if (!user) {
      return renderLogin(req, res, 'Invalid credentials or inactive account.');
    }

    req.session.user = {
      id: user.user_id,
      name: user.user_name,
      role: user.user_role,
    };

    return res.redirect(roleHomePath(user.user_role));
  } catch (error) {
    console.error('Login failed', error);
    return renderLogin(req, res, 'Unable to sign in right now.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', requireAuth, (req, res) => res.redirect(roleHomePath(req.session.user.role)));
app.get('/dashboard', requireAuth, (req, res) => res.redirect(roleHomePath(req.session.user.role)));

app.get('/admin', requireRole('Admin'), async (req, res) => {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [usersData, merchantsData, rulesData, auditData, summaryRows] = await Promise.all([
    loadAdminUsers(previewReq),
    loadAdminMerchants(previewReq),
    loadAdminRules(previewReq),
    loadAdminAudit(previewReq),
    database.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_users,
         (SELECT COUNT(*) FROM users WHERE is_active = 0) AS disabled_users,
         (SELECT COUNT(*) FROM merchants WHERE is_active = 1) AS active_merchants,
         (SELECT COUNT(*) FROM compliance_rules WHERE is_active = 1) AS active_rules,
         (SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = CURDATE()) AS transactions_today,
         (SELECT COUNT(*) FROM cases WHERE status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases`,
    ).then(([rows]) => rows),
  ]);
  return res.render('admin-dashboard', {
    title: 'Admin Overview',
    activePage: 'admin',
    currentUser: req.session.user,
    summary: summaryRows[0] || {},
    userPreview: usersData.rows.slice(0, 5),
    merchantPreview: merchantsData.rows.slice(0, 5),
    rulePreview: rulesData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
});

app.get('/admin/users', requireRole('Admin'), async (req, res) => {
  const data = await loadAdminUsers(req);
  return res.render('admin-users', {
    title: 'User Management',
    activePage: 'admin-users',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/admin/merchants', requireRole('Admin'), async (req, res) => {
  const data = await loadAdminMerchants(req);
  return res.render('admin-merchants', {
    title: 'Merchant Management',
    activePage: 'admin-merchants',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/admin/rules', requireRole('Admin'), async (req, res) => {
  const data = await loadAdminRules(req);
  return res.render('admin-rules', {
    title: 'Rule Management',
    activePage: 'admin-rules',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/admin/audit-log', requireRole('Admin'), async (req, res) => {
  const data = await loadAdminAudit(req);
  return res.render('admin-audit-log', {
    title: 'Admin Audit Log',
    activePage: 'admin-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
});

app.get('/analyst', requireRole('Analyst'), async (req, res) => {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [queueData, casesData, auditData, newTransactionsRows] = await Promise.all([
    loadAnalystQueue(previewReq),
    loadAnalystCases(previewReq),
    loadAnalystAudit(previewReq),
    database.query("SELECT COUNT(*) AS total FROM transactions WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)").then(([rows]) => rows),
  ]);
  return res.render('analyst-dashboard', {
    title: 'Analyst Overview',
    activePage: 'analyst',
    currentUser: req.session.user,
    summary: {
      newTransactions: Number(newTransactionsRows[0]?.total || 0),
      criticalQueue: Number(queueData.summary.critical || 0),
      openCases: Number(casesData.summary.open_cases || 0),
      assignedToMe: Number(casesData.summary.assigned_to_me || 0),
      waiting: Number(casesData.summary.waiting || 0),
      overdue: Number(casesData.summary.overdue || 0),
    },
    queuePreview: queueData.rows.slice(0, 5),
    casePreview: casesData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
});

app.get('/analyst/live-transactions', requireRole('Analyst'), async (req, res) => {
  const data = await loadAnalystTransactions(req);
  return res.render('analyst-live-transactions', {
    title: 'Live Transaction Feed',
    activePage: 'analyst-live-transactions',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/analyst/working-queue', requireRole('Analyst'), async (req, res) => {
  const data = await loadAnalystQueue(req);
  return res.render('analyst-working-queue', {
    title: 'Operations Working Queue',
    activePage: 'analyst-working-queue',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/analyst/cases', requireRole('Analyst'), async (req, res) => {
  const data = await loadAnalystCases(req);
  return res.render('analyst-cases', {
    title: 'Cases',
    activePage: 'analyst-cases',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/analyst/audit-log', requireRole('Analyst'), async (req, res) => {
  const data = await loadAnalystAudit(req);
  return res.render('analyst-audit-log', {
    title: 'Audit Log',
    activePage: 'analyst-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
});

app.get('/senior-analyst', requireRole('Senior Analyst'), async (req, res) => {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [caseData, auditData, resolvedRows] = await Promise.all([
    loadSeniorCases(previewReq),
    loadSeniorAudit(previewReq),
    database.query(
      `SELECT COUNT(*) AS total
       FROM cases c
       JOIN transactions t ON t.transaction_id = c.transaction_id
       WHERE ${seniorCaseWhereAndValues({}).where.join(' AND ')}
         AND c.status IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')
         AND DATE(c.updated_at) = CURDATE()`,
    ).then(([rows]) => rows),
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
      resolvedToday: Number(resolvedRows[0]?.total || 0),
    },
    casePreview: caseData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
});

app.get('/senior-analyst/cases', requireRole('Senior Analyst'), async (req, res) => {
  const data = await loadSeniorCases(req);
  return res.render('senior-analyst-cases', {
    title: 'Cases Pending Senior Review',
    activePage: 'senior-analyst-cases',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/senior-analyst/audit-log', requireRole('Senior Analyst'), async (req, res) => {
  const data = await loadSeniorAudit(req);
  return res.render('senior-analyst-audit-log', {
    title: 'Senior Analyst Audit Log',
    activePage: 'senior-analyst-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
});

app.get('/stro', requireRole('STRO'), async (req, res) => {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [caseData, reportData, auditData] = await Promise.all([
    loadStroCases(previewReq),
    loadStroReports(previewReq),
    loadStroAudit(previewReq),
  ]);
  return res.render('stro-dashboard', {
    title: 'STRO Overview',
    activePage: 'stro',
    currentUser: req.session.user,
    summary: {
      referred: Number(caseData.summary.referred || 0),
      recommended: Number(caseData.summary.recommended || 0),
      draft: Number(caseData.summary.draft || 0),
      pendingApproval: Number(caseData.summary.pending_approval || 0),
      filed: Number(caseData.summary.filed || 0),
      waiting: Number(caseData.summary.waiting || 0),
    },
    casePreview: caseData.rows.slice(0, 5),
    reportPreview: reportData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
  });
});

app.get('/stro/cases', requireRole('STRO'), async (req, res) => {
  const data = await loadStroCases(req);
  return res.render('stro-cases', {
    title: 'STRO Cases',
    activePage: 'stro-cases',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/stro/str-reports', requireRole('STRO'), async (req, res) => {
  const data = await loadStroReports(req);
  return res.render('stro-str-reports', {
    title: 'STR Reports',
    activePage: 'stro-str-reports',
    currentUser: req.session.user,
    ...data,
  });
});

app.get('/stro/audit-log', requireRole('STRO'), async (req, res) => {
  const data = await loadStroAudit(req);
  return res.render('stro-audit-log', {
    title: 'STRO Audit Log',
    activePage: 'stro-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
});

app.get('/transactions/:id', requireAuth, async (req, res) => {
  await ensureCaseAssignmentColumns();
  await ensureStrWorkflowSchema();

  const [transactionRows, caseRows, ruleRows, activityRows] = await Promise.all([
    database.query(
      `SELECT t.*, m.merchant_name, m.mcc_risk_score
       FROM transactions t
       LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
       WHERE t.transaction_id = ?
       LIMIT 1`,
      [req.params.id],
    ).then(([rows]) => rows),
    database.query(
      `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.status, c.notes,
              c.assigned_role, c.escalation_destination, c.referred_to_stro_at, c.referred_to_stro_by,
              c.due_at, c.created_at, c.updated_at, u.user_name AS assigned_user_name,
              sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
              sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
              sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by, sr.approved_by,
              sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason, sr.updated_at AS str_updated_at,
              prepared.user_name AS prepared_by_name, approved.user_name AS approved_by_name,
              filed.user_name AS filed_by_name, referred.user_name AS referred_by_user_name,
              referred.user_role AS referred_by_user_role
       FROM cases c
       LEFT JOIN users u ON u.user_id = c.assigned_to
       LEFT JOIN str_reports sr ON sr.case_id = c.case_id
       LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
       LEFT JOIN users approved ON approved.user_id = sr.approved_by
       LEFT JOIN users filed ON filed.user_id = sr.filed_by
       LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
       WHERE c.transaction_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.id],
    ).then(([rows]) => rows),
    database.query(
      `SELECT tmr.rule_id, tmr.matched_at, cr.rule_name, cr.risk_level, cr.reason, cr.weight, cr.rule_type
       FROM transaction_matched_rules tmr
       LEFT JOIN compliance_rules cr ON cr.rule_id = tmr.rule_id
       WHERE tmr.transaction_id = ?
       ORDER BY tmr.matched_at ASC`,
      [req.params.id],
    ).then(([rows]) => rows).catch((error) => {
      console.error('Unable to load transaction matched rules', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
    database.query(
      `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action, al.user_id, al.notes, al.created_at,
              u.user_name, u.user_role
       FROM audit_logs al
       LEFT JOIN users u ON u.user_id = al.user_id
       WHERE al.transaction_id = ?
       ORDER BY al.created_at ASC`,
      [req.params.id],
    ).then(([rows]) => rows).catch((error) => {
      console.error('Unable to load transaction activity logs', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
  ]);

  const transaction = transactionRows[0] || null;
  if (!transaction) {
    return res.status(404).render('transaction-detail', {
      title: 'Transaction Not Found',
      activePage: activePageForRole(req.session.user.role),
      transaction: null,
      currentUser: req.session.user,
      currentRole: req.session.user.role,
      caseRecord: null,
      riskContributions: [],
      activityLogs: [],
      emailTestMode: isEmailDevelopmentMode(),
    });
  }

  const caseRecord = caseRows[0] || null;
  return res.render('transaction-detail', {
    title: `Transaction ${transaction.transaction_id}`,
    activePage: activePageForRole(req.session.user.role),
    transaction,
    caseRecord,
    riskContributions: ruleRows,
    activityLogs: activityRows,
    currentUser: req.session.user,
    currentRole: req.session.user.role,
    emailTestMode: isEmailDevelopmentMode(),
  });
});

app.patch('/api/cases/:caseId/assign-to-me', requireAuth, async (req, res) => {
  const currentUser = req.session.user;
  if (!['Analyst', 'Senior Analyst'].includes(currentUser.role)) {
    return forbidJson(res);
  }

  try {
    await ensureCaseAssignmentColumns();

    const [rows] = await database.query(
      `SELECT c.case_id, c.transaction_id, c.assigned_to, c.status, c.due_at,
              u.user_name AS assigned_user_name
       FROM cases c
       LEFT JOIN users u ON u.user_id = c.assigned_to
       WHERE c.case_id = ?
       LIMIT 1`,
      [req.params.caseId],
    );
    const caseRow = rows[0];
    if (!caseRow) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    const resolvedStatuses = ['Resolved', 'Dismissed as False Positive', 'STR Filed'];
    if (resolvedStatuses.includes(caseRow.status)) {
      return res.status(409).json({ success: false, message: 'Resolved cases cannot be assigned.' });
    }

    if (caseRow.assigned_to) {
      const ownerName = caseRow.assigned_user_name || caseRow.assigned_to;
      return res.status(409).json({
        success: false,
        message: caseRow.assigned_to === currentUser.id
          ? 'This case is already assigned to you.'
          : `This case is already assigned to ${ownerName}.`,
      });
    }

    const dueAt = addWorkingDays(new Date(), 2);
    const dueAtSql = dueAt.toISOString().slice(0, 19).replace('T', ' ');
    const [updateResult] = await database.execute(
      `UPDATE cases
       SET assigned_to = ?, status = 'Under Review', due_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ? AND assigned_to IS NULL`,
      [currentUser.id, dueAtSql, caseRow.case_id],
    );
    if (updateResult.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'This case was assigned by another user. Please refresh the page.' });
    }

    const dueDateLabel = dueAt.toLocaleDateString('en-SG');
    const auditMessage = `Case assigned to ${currentUser.name} with due date ${dueDateLabel}.`;
    const auditId = id('AUD');
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        auditId,
        caseRow.transaction_id,
        'Case',
        caseRow.case_id,
        'Case Assigned',
        currentUser.id,
        auditMessage,
      ],
    );

    return res.status(200).json({
      success: true,
      message: 'Case assigned successfully.',
      case: {
        caseId: caseRow.case_id,
        transactionId: caseRow.transaction_id,
        assignedUserId: currentUser.id,
        assignedAnalyst: currentUser.name,
        assessmentStatus: 'Under Review',
        dueAt: dueAt.toISOString(),
      },
      auditEntry: {
        auditId,
        transactionId: caseRow.transaction_id,
        entityType: 'Case',
        entityId: caseRow.case_id,
        action: 'Case Assigned',
        userId: currentUser.id,
        userName: currentUser.name,
        userRole: currentUser.role,
        notes: auditMessage,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Assign to me failed', {
      caseId: req.params.caseId,
      userId: currentUser.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to assign this case right now.' });
  }
});

// Safety net for the analyst self-select workflow above: a Critical (or already-overdue) case
// that nobody has claimed within STALE_CASE_MINUTES gets pushed to whichever active Analyst
// currently has the fewest open cases, so high-risk work never sits idle just because the
// queue wasn't triaged in time. Reuses the same atomic "WHERE assigned_to IS NULL" guard as
// assign-to-me above so it can never clobber a manual claim made in between the SELECT and
// the UPDATE. user_id is left NULL on the audit entry since the actor is the system, not the
// analyst it assigned to - the audit-log views already render that as "System".
const STALE_CASE_MINUTES = 15;

async function autoAssignStaleCriticalCases() {
  if (!database.isEnabled()) return;

  const [staleCases] = await database.query(
    `SELECT c.case_id, c.transaction_id
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     WHERE c.assigned_to IS NULL
       AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')
       AND (t.risk_level = 'Critical' OR (c.due_at IS NOT NULL AND c.due_at < NOW()))
       AND c.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [STALE_CASE_MINUTES],
  );
  if (!staleCases.length) return;

  const [analysts] = await database.query(
    `SELECT u.user_id, u.user_name,
            (SELECT COUNT(*) FROM cases c2
             WHERE c2.assigned_to = u.user_id
               AND c2.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases
     FROM users u
     WHERE u.user_role = 'Analyst' AND u.is_active = 1
     ORDER BY open_cases ASC, u.user_name ASC`,
  );
  if (!analysts.length) return;

  for (const staleCase of staleCases) {
    const analyst = analysts[0];
    const dueAt = addWorkingDays(new Date(), 2);
    const dueAtSql = dueAt.toISOString().slice(0, 19).replace('T', ' ');

    const [updateResult] = await database.execute(
      `UPDATE cases
       SET assigned_to = ?, status = 'Under Review', due_at = COALESCE(due_at, ?), updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ? AND assigned_to IS NULL`,
      [analyst.user_id, dueAtSql, staleCase.case_id],
    );
    if (updateResult.affectedRows === 0) continue; // claimed manually in the meantime

    analyst.open_cases += 1;
    analysts.sort((a, b) => a.open_cases - b.open_cases || a.user_name.localeCompare(b.user_name));

    const auditMessage = `Case auto-assigned to ${analyst.user_name} after sitting unassigned for over ${STALE_CASE_MINUTES} minutes.`;
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NOW())`,
      [id('AUD'), staleCase.transaction_id, 'Case', staleCase.case_id, 'Case Auto-Assigned', auditMessage],
    );
  }
}

async function loadRoleCaseContext(transactionId) {
  await ensureStrWorkflowSchema();
  const [rows] = await database.query(
    `SELECT t.*, m.merchant_name,
            c.case_id, c.assigned_to, c.assigned_role, c.escalation_destination, c.status AS case_status,
            c.due_at, c.referred_to_stro_at, c.referred_to_stro_by,
            sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
            sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
            sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by, sr.approved_by,
            sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

function isResolvedCaseStatus(status) {
  return ['Resolved', 'Dismissed as False Positive', 'STR Filed'].includes(status);
}

async function auditCaseAction({ transactionId, caseId, action, userId, notes }) {
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), transactionId, 'Case', caseId, action, userId, notes],
  );
}

app.post('/api/transactions/:id/refer-to-stro', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'Senior Analyst') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be referred to STRO.' });
  }
  if (context.str_status || context.assigned_role === 'STRO' || context.escalation_destination === 'STRO') {
    return res.status(409).json({ success: false, message: 'This case has already been referred to STRO.' });
  }

  const referralReason = String(req.body.referralReason || '').trim();
  const referralSummary = String(req.body.referralSummary || '').trim();
  const seniorAnalystNotes = String(req.body.seniorAnalystNotes || '').trim();
  const supportingEvidence = normalizeEvidence(req.body.supportingEvidence);

  if (!stroReferralReasons.includes(referralReason)) {
    return res.status(400).json({ success: false, message: 'Please select a valid referral reason.' });
  }
  if (!hasMeaningfulText(referralSummary, 30)) {
    return res.status(400).json({ success: false, message: 'Summary for STRO must contain at least 30 meaningful characters.' });
  }
  if (!hasMeaningfulText(seniorAnalystNotes, 10)) {
    return res.status(400).json({ success: false, message: 'Senior Analyst notes must contain at least 10 meaningful characters.' });
  }
  if (!supportingEvidence.length) {
    return res.status(400).json({ success: false, message: 'Select at least one supporting evidence type.' });
  }

  const now = new Date();
  await database.execute(
    `UPDATE cases
     SET status = 'Escalated',
         assigned_role = 'STRO',
         escalation_destination = 'STRO',
         referred_to_stro_at = ?,
         referred_to_stro_by = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [formatSqlDateTime(now), req.session.user.id, context.case_id],
  );
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())`,
    [
      id('STR'),
      context.transaction_id,
      context.case_id,
      referralReason,
      referralSummary,
      JSON.stringify(supportingEvidence),
      seniorAnalystNotes,
    ],
  );
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'Case Referred to STRO',
    userId: req.session.user.id,
    notes: 'Case referred to STRO by Senior Analyst after senior review.',
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Recommended',
    userId: req.session.user.id,
    notes: 'STR review recommended by Senior Analyst.',
  });

  return res.status(200).json({
    success: true,
    message: 'Case referred to STRO successfully.',
    assessmentStatus: 'Escalated',
    escalatedTo: 'STRO',
    assignedRole: 'STRO',
    strStatus: 'Recommended',
  });
});

app.post('/api/transactions/:id/escalate', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'Analyst') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be escalated.' });
  }
  if (context.str_status === 'Filed') {
    return res.status(409).json({ success: false, message: 'Filed STR cases cannot be referred again.' });
  }
  if (context.assigned_role || context.escalation_destination || context.str_status) {
    return res.status(409).json({ success: false, message: 'This case has already been routed.' });
  }

  const destination = String(req.body.escalationDestination || '').trim();
  const reason = String(req.body.escalationReason || '').trim();
  const notes = String(req.body.escalationNotes || '').trim();
  if (!escalationDestinations.includes(destination)) {
    return res.status(400).json({ success: false, message: 'Please select a valid escalation destination.' });
  }
  if (!escalationReasons.includes(reason)) {
    return res.status(400).json({ success: false, message: 'Please select a valid escalation reason.' });
  }
  if (!hasMeaningfulText(notes, 10)) {
    return res.status(400).json({ success: false, message: 'Escalation notes must contain at least 10 meaningful characters.' });
  }

  if (destination === 'Senior Analyst') {
    await database.execute(
      `UPDATE cases
       SET status = 'Pending Senior Review',
           assigned_role = 'Senior Analyst',
           escalation_destination = 'Senior Analyst',
           notes = COALESCE(?, notes),
           updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [notes, context.case_id],
    );
    await database.execute(
      "UPDATE transactions SET action_status = 'Pending Senior Review', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
      [context.transaction_id],
    );
    await auditCaseAction({
      transactionId: context.transaction_id,
      caseId: context.case_id,
      action: 'Case Escalated to Senior Analyst',
      userId: req.session.user.id,
      notes: 'Case escalated to Senior Analyst for critical-risk review.',
    });
    return res.status(200).json({
      success: true,
      message: 'Case escalated to Senior Analyst.',
      assessmentStatus: 'Escalated',
      escalatedTo: 'Senior Analyst',
      assignedRole: 'Senior Analyst',
      strStatus: 'Not Started',
    });
  }

  await database.execute(
    `UPDATE cases
     SET status = 'Escalated',
         assigned_role = 'STRO',
         escalation_destination = 'STRO',
         referred_to_stro_at = ?,
         referred_to_stro_by = ?,
         notes = COALESCE(?, notes),
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [formatSqlDateTime(new Date()), req.session.user.id, notes, context.case_id],
  );
  await database.execute(
    "UPDATE transactions SET action_status = 'Escalated', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
    [context.transaction_id],
  );
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())`,
    [
      id('STR'),
      context.transaction_id,
      context.case_id,
      reason,
      notes,
      JSON.stringify(['Transaction behaviour']),
      notes,
    ],
  );
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'Case Referred to STRO',
    userId: req.session.user.id,
    notes: 'Case referred directly to STRO by Analyst for suspicious transaction reporting review.',
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Recommended',
    userId: req.session.user.id,
    notes: 'STR review recommended by Analyst.',
  });
  return res.status(200).json({
    success: true,
    message: 'Case referred directly to STRO.',
    assessmentStatus: 'Escalated',
    escalatedTo: 'STRO',
    assignedRole: 'STRO',
    strStatus: 'Recommended',
  });
});

function validateStrTransition(currentStatus, nextStatus) {
  const current = currentStatus || 'Recommended';
  const allowed = {
    Recommended: ['Draft', 'Not Required'],
    Draft: ['Draft', 'Pending Approval', 'Filed', 'Not Required'],
    'Pending Approval': ['Filed', 'Not Required'],
    Filed: [],
    'Not Required': [],
  };
  return (allowed[current] || []).includes(nextStatus);
}

app.patch('/api/transactions/:id/str', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'STRO') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be updated for STR.' });
  }
  if (context.assigned_role !== 'STRO' && context.escalation_destination !== 'STRO') {
    return res.status(403).json({ success: false, message: 'This case is not routed to STRO.' });
  }
  if (!context.str_status) {
    return res.status(409).json({ success: false, message: 'This case has not been referred for STR review.' });
  }

  const nextStatus = String(req.body.strStatus || '').trim();
  if (!['Draft', 'Pending Approval', 'Filed'].includes(nextStatus)) {
    return res.status(400).json({ success: false, message: 'Invalid STR status.' });
  }
  if (!validateStrTransition(context.str_status, nextStatus)) {
    return res.status(409).json({ success: false, message: `Cannot change STR status from ${context.str_status} to ${nextStatus}.` });
  }

  const reportingReason = String(req.body.reportingReason || '').trim();
  const suspicionSummary = String(req.body.suspicionSummary || '').trim();
  const stroNotes = String(req.body.stroNotes || '').trim();
  const referenceNumber = String(req.body.referenceNumber || '').trim();
  const filingDate = String(req.body.filingDate || '').trim();
  const supportingEvidence = normalizeEvidence(req.body.supportingEvidence);
  const confirmation = req.body.confirmAccurate === true || req.body.confirmAccurate === 'true' || req.body.confirmAccurate === 'on';

  if (!hasMeaningfulText(reportingReason, 20)) {
    return res.status(400).json({ success: false, message: 'Reporting reason must contain at least 20 meaningful characters.' });
  }
  if (!hasMeaningfulText(suspicionSummary, 30)) {
    return res.status(400).json({ success: false, message: 'Suspicion summary must contain at least 30 meaningful characters.' });
  }
  if (!hasMeaningfulText(stroNotes, 10)) {
    return res.status(400).json({ success: false, message: 'STRO notes must contain at least 10 meaningful characters.' });
  }
  if (!supportingEvidence.length) {
    return res.status(400).json({ success: false, message: 'Select at least one supporting evidence type.' });
  }
  if (nextStatus === 'Filed' && (!referenceNumber || !filingDate || !confirmation)) {
    return res.status(400).json({ success: false, message: 'Filing reference, filing date and confirmation are required to mark an STR as filed.' });
  }

  const transactionSummary = buildTransactionSummary(context);
  const preparedBy = context.prepared_by || req.session.user.id;
  const filedBy = nextStatus === 'Filed' ? req.session.user.id : context.filed_by || null;
  const filedAt = nextStatus === 'Filed' ? formatSqlDateTime(new Date()) : context.filed_at || null;
  const action = nextStatus === 'Filed'
    ? 'STR Filed'
    : nextStatus === 'Pending Approval'
      ? 'STR Submitted for Approval'
      : 'STR Draft Saved';
  const notes = nextStatus === 'Filed'
    ? `STR filed with internal reference ${referenceNumber}.`
    : nextStatus === 'Pending Approval'
      ? 'STR submitted for approval by the assigned STRO.'
      : 'STR draft saved by the assigned STRO.';

  await database.execute(
    `UPDATE str_reports
     SET str_status = ?, reference_number = ?, reporting_reason = ?, suspicion_summary = ?,
         transaction_summary = ?, supporting_evidence = ?, stro_notes = ?, prepared_by = ?,
         filed_by = ?, filing_date = ?, filed_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [
      nextStatus,
      referenceNumber || context.reference_number || null,
      reportingReason,
      suspicionSummary,
      transactionSummary,
      JSON.stringify(supportingEvidence),
      stroNotes,
      preparedBy,
      filedBy,
      filingDate || context.filing_date || null,
      filedAt,
      context.case_id,
    ],
  );
  if (nextStatus === 'Filed') {
    await database.execute(
      "UPDATE cases SET status = 'STR Filed', updated_at = CURRENT_TIMESTAMP WHERE case_id = ?",
      [context.case_id],
    );
    await database.execute(
      "UPDATE transactions SET action_status = 'STR Filed', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
      [context.transaction_id],
    );
  }
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action,
    userId: req.session.user.id,
    notes,
  });

  return res.status(200).json({
    success: true,
    message: notes,
    strStatus: nextStatus,
    referenceNumber: referenceNumber || context.reference_number || null,
    filingDate: filingDate || context.filing_date || null,
  });
});

app.post('/api/transactions/:id/str/not-required', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'STRO') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be updated for STR.' });
  }
  if (context.assigned_role !== 'STRO' && context.escalation_destination !== 'STRO') {
    return res.status(403).json({ success: false, message: 'This case is not routed to STRO.' });
  }
  if (!validateStrTransition(context.str_status || 'Recommended', 'Not Required')) {
    return res.status(409).json({ success: false, message: `Cannot mark STR as Not Required from ${context.str_status}.` });
  }

  const reason = String(req.body.reason || '').trim();
  if (!hasMeaningfulText(reason, 20)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful reason of at least 20 characters.' });
  }

  await database.execute(
    `UPDATE str_reports
     SET str_status = 'Not Required', not_required_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [reason, context.case_id],
  );
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Marked Not Required',
    userId: req.session.user.id,
    notes: 'STR marked not required after STRO review.',
  });

  return res.status(200).json({ success: true, message: 'STR marked as not required.', strStatus: 'Not Required' });
});

function backPath(req, fallback) {
  return req.body.returnTo || req.get('referer') || fallback;
}

function auditEntryForAction(userId, transactionId, action, notes) {
  return {
    auditId: id('AUD'),
    transactionId,
    action,
    userId,
    notes,
    createdAt: new Date().toISOString(),
  };
}

async function logAdminAudit({
  // Writes directly to the audit_logs row shape (transaction_id/user_id/notes) that the
  // Admin/Analyst/STRO routes use.
  action, userId, notes = null, transactionId = null, entityType = null, entityId = null,
}) {
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), transactionId, entityType, entityId, action, userId, notes],
  );
}

app.post('/admin/users', requireRole('Admin'), async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  const userName = String(req.body.userName || '').trim();
  const userRole = String(req.body.userRole || '').trim();
  const password = String(req.body.password || '');
  const isActive = req.body.isActive !== '0';
  if (!userId || !userName || !userRole || !password) return res.redirect('/admin/users');

  const [result] = await database.execute(
    `INSERT INTO users (user_id, user_name, user_role, password, is_active)
     VALUES (?, ?, ?, SHA2(?, 256), ?)
     ON DUPLICATE KEY UPDATE
       user_name = VALUES(user_name),
       user_role = VALUES(user_role),
       password = VALUES(password),
       is_active = VALUES(is_active)`,
    [userId, userName, userRole, password, isActive ? 1 : 0],
  );

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'User Created' : 'User Updated',
    userId: req.session.user.id,
    entityType: 'User',
    entityId: userId,
    notes: `${userName} (${userRole})`,
  });

  return res.redirect('/admin/users');
});

app.post('/admin/users/:id', requireRole('Admin'), async (req, res) => {
  const isSelf = req.params.id === req.session.user.id;
  const updates = [];
  const values = [];
  if (req.body.userName) { updates.push('user_name = ?'); values.push(String(req.body.userName).trim()); }
  if (req.body.userRole && !isSelf) { updates.push('user_role = ?'); values.push(String(req.body.userRole).trim()); }
  if (req.body.password) { updates.push('password = SHA2(?, 256)'); values.push(String(req.body.password)); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, values);
    await logAdminAudit({
      action: 'User Updated',
      userId: req.session.user.id,
      entityType: 'User',
      entityId: req.params.id,
      notes: req.body.userRole && isSelf ? 'Role change ignored: admin cannot change their own role' : null,
    });
  }
  return res.redirect('/admin/users');
});

app.post('/admin/users/:id/toggle', requireRole('Admin'), async (req, res) => {
  const [rows] = await database.query('SELECT is_active FROM users WHERE user_id = ? LIMIT 1', [req.params.id]);
  const current = rows[0];
  if (current) {
    const nextActive = current.is_active ? 0 : 1;
    await database.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [nextActive, req.params.id]);
    await logAdminAudit({
      action: nextActive ? 'User Activated' : 'User Deactivated',
      userId: req.session.user.id,
      entityType: 'User',
      entityId: req.params.id,
    });
  }
  return res.redirect('/admin/users');
});

app.post('/admin/users/:id/delete', requireRole('Admin'), async (req, res) => {
  await database.execute('DELETE FROM users WHERE user_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'User Deleted',
    userId: req.session.user.id,
    entityType: 'User',
    entityId: req.params.id,
  });
  return res.redirect('/admin/users');
});

app.post('/admin/merchants', requireRole('Admin'), async (req, res) => {
  const merchantId = String(req.body.merchantId || '').trim();
  const merchantName = String(req.body.merchantName || '').trim();
  const mccCode = String(req.body.mccCode || '').trim();
  const industry = String(req.body.industry || '').trim();
  const mccRiskScore = Number(req.body.mccRiskScore || 0);
  const merchantMid = String(req.body.merchantMid || '').trim() || null;
  const merchantCountry = String(req.body.merchantCountry || '').trim() || null;
  const riskTier = req.body.riskTier === 'High' ? 'High' : 'Standard';
  const isActive = req.body.isActive !== '0';
  if (!merchantId || !merchantName || !mccCode || !industry) return res.redirect('/admin/merchants');

  const [result] = await database.execute(
    `INSERT INTO merchants (merchant_id, merchant_name, mcc_code, industry, mcc_risk_score, merchant_mid, merchant_country, risk_tier, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       merchant_name = VALUES(merchant_name),
       mcc_code = VALUES(mcc_code),
       industry = VALUES(industry),
       mcc_risk_score = VALUES(mcc_risk_score),
       merchant_mid = VALUES(merchant_mid),
       merchant_country = VALUES(merchant_country),
       risk_tier = VALUES(risk_tier),
       is_active = VALUES(is_active)`,
    [merchantId, merchantName, mccCode, industry, mccRiskScore, merchantMid, merchantCountry, riskTier, isActive ? 1 : 0],
  );

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'Merchant Created' : 'Merchant Updated',
    userId: req.session.user.id,
    entityType: 'Merchant',
    entityId: merchantId,
    notes: `${merchantName} (MCC ${mccCode})`,
  });

  return res.redirect('/admin/merchants');
});

app.post('/admin/merchants/:id', requireRole('Admin'), async (req, res) => {
  const updates = [];
  const values = [];
  if (req.body.merchantName) { updates.push('merchant_name = ?'); values.push(String(req.body.merchantName).trim()); }
  if (req.body.mccCode) { updates.push('mcc_code = ?'); values.push(String(req.body.mccCode).trim()); }
  if (req.body.industry) { updates.push('industry = ?'); values.push(String(req.body.industry).trim()); }
  if (req.body.mccRiskScore !== undefined) { updates.push('mcc_risk_score = ?'); values.push(Number(req.body.mccRiskScore || 0)); }
  if (req.body.merchantMid !== undefined) { updates.push('merchant_mid = ?'); values.push(String(req.body.merchantMid).trim() || null); }
  if (req.body.merchantCountry !== undefined) { updates.push('merchant_country = ?'); values.push(String(req.body.merchantCountry).trim() || null); }
  if (req.body.riskTier !== undefined) { updates.push('risk_tier = ?'); values.push(req.body.riskTier === 'High' ? 'High' : 'Standard'); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE merchants SET ${updates.join(', ')} WHERE merchant_id = ?`, values);
    await logAdminAudit({
      action: 'Merchant Updated',
      userId: req.session.user.id,
      entityType: 'Merchant',
      entityId: req.params.id,
    });
  }
  return res.redirect('/admin/merchants');
});

app.post('/admin/merchants/:id/delete', requireRole('Admin'), async (req, res) => {
  await database.execute('DELETE FROM merchants WHERE merchant_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'Merchant Deleted',
    userId: req.session.user.id,
    entityType: 'Merchant',
    entityId: req.params.id,
  });
  return res.redirect('/admin/merchants');
});

app.post('/admin/rules', requireRole('Admin'), async (req, res) => {
  const payload = {
    ruleId: String(req.body.ruleId || '').trim(),
    merchantId: req.body.merchantId ? String(req.body.merchantId).trim() : null,
    ruleName: String(req.body.ruleName || '').trim(),
    riskLevel: String(req.body.riskLevel || 'Low').trim(),
    reason: String(req.body.reason || '').trim(),
    weight: Number(req.body.weight || 0),
    amountThreshold: req.body.amountThreshold ? Number(req.body.amountThreshold) : null,
    countThreshold: req.body.countThreshold ? Number(req.body.countThreshold) : null,
    ruleType: String(req.body.ruleType || 'runtime_rule').trim(),
    isActive: req.body.isActive !== '0',
  };

  if (!payload.ruleId || !payload.ruleName || !payload.reason) return res.redirect('/admin/rules');

  const [result] = await database.execute(
    `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       merchant_id = VALUES(merchant_id),
       rule_name = VALUES(rule_name),
       risk_level = VALUES(risk_level),
       reason = VALUES(reason),
       weight = VALUES(weight),
       amount_threshold = VALUES(amount_threshold),
       count_threshold = VALUES(count_threshold),
       rule_type = VALUES(rule_type),
       is_active = VALUES(is_active)`,
    [payload.ruleId, payload.merchantId, payload.ruleName, payload.riskLevel, payload.reason, payload.weight, payload.amountThreshold, payload.countThreshold, payload.ruleType, payload.isActive ? 1 : 0],
  );

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'Rule Created' : 'Rule Updated',
    userId: req.session.user.id,
    entityType: 'Rule',
    entityId: payload.ruleId,
    notes: payload.ruleName,
  });

  return res.redirect('/admin/rules');
});

app.post('/admin/rules/:id', requireRole('Admin'), async (req, res) => {
  const updates = [];
  const values = [];
  if (req.body.merchantId !== undefined) { updates.push('merchant_id = ?'); values.push(req.body.merchantId ? String(req.body.merchantId).trim() : null); }
  if (req.body.ruleName) { updates.push('rule_name = ?'); values.push(String(req.body.ruleName).trim()); }
  if (req.body.riskLevel) { updates.push('risk_level = ?'); values.push(String(req.body.riskLevel).trim()); }
  if (req.body.reason) { updates.push('reason = ?'); values.push(String(req.body.reason).trim()); }
  if (req.body.weight !== undefined) { updates.push('weight = ?'); values.push(Number(req.body.weight || 0)); }
  if (req.body.amountThreshold !== undefined) { updates.push('amount_threshold = ?'); values.push(req.body.amountThreshold === '' ? null : Number(req.body.amountThreshold)); }
  if (req.body.countThreshold !== undefined) { updates.push('count_threshold = ?'); values.push(req.body.countThreshold === '' ? null : Number(req.body.countThreshold)); }
  if (req.body.ruleType) { updates.push('rule_type = ?'); values.push(String(req.body.ruleType).trim()); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE compliance_rules SET ${updates.join(', ')} WHERE rule_id = ?`, values);
    await logAdminAudit({
      action: 'Rule Updated',
      userId: req.session.user.id,
      entityType: 'Rule',
      entityId: req.params.id,
    });
  }
  return res.redirect('/admin/rules');
});

app.post('/admin/rules/:id/delete', requireRole('Admin'), async (req, res) => {
  await database.execute('DELETE FROM compliance_rules WHERE rule_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'Rule Deleted',
    userId: req.session.user.id,
    entityType: 'Rule',
    entityId: req.params.id,
  });
  return res.redirect('/admin/rules');
});

app.post('/analyst/cases/:id/action', requireRole('Analyst'), async (req, res) => {
  await ensureStrWorkflowSchema();
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query(
    `SELECT c.transaction_id, t.risk_level
     FROM cases c
     JOIN transactions t ON c.transaction_id = t.transaction_id
     WHERE c.case_id = ?
     LIMIT 1`,
    [req.params.id],
  );
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/analyst/cases');

  // Escalation routing follows the confirmed rule: Critical-risk cases need a Senior
  // Analyst's review first (Scenario 2) before reaching STRO; everything else escalates
  // straight to STRO (Scenario 1).
  const escalation = caseRow.risk_level === 'Critical'
    ? { status: 'Pending Senior Review', actionStatus: 'Pending Senior Review', label: 'Case Escalated to Senior Analyst', destination: 'Senior Analyst', assignedRole: 'Senior Analyst', strStatus: 'Not Started' }
    : { status: 'Escalated', actionStatus: 'Escalated', label: 'Case Referred to STRO', destination: 'STRO', assignedRole: 'STRO', strStatus: 'Recommended' };

  const actionMap = {
    escalate: escalation,
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/analyst/cases');

  await database.execute('UPDATE cases SET status = ?, assigned_role = COALESCE(?, assigned_role), escalation_destination = COALESCE(?, escalation_destination), referred_to_stro_at = CASE WHEN ? = "STRO" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END, referred_to_stro_by = CASE WHEN ? = "STRO" THEN ? ELSE referred_to_stro_by END, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, selected.assignedRole || null, selected.destination || null, selected.destination || null, selected.destination || null, req.session.user.id, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  if (selected.destination === 'STRO') {
    await database.execute(
      `INSERT INTO str_reports (
        str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
        supporting_evidence, senior_analyst_notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE str_status = str_status`,
      [id('STR'), caseRow.transaction_id, req.params.id, 'Possible suspicious activity / STR consideration', notes || selected.label, JSON.stringify(['Transaction behaviour']), notes || selected.label],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/analyst/cases');
});

app.post('/senior-analyst/cases/:id/action', requireRole('Senior Analyst'), async (req, res) => {
  await ensureStrWorkflowSchema();
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query('SELECT transaction_id FROM cases WHERE case_id = ? LIMIT 1', [req.params.id]);
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/senior-analyst/cases');

  const actionMap = {
    escalate: { status: 'Escalated', actionStatus: 'Escalated', label: 'Escalated to STRO' },
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/senior-analyst/cases');

  await database.execute('UPDATE cases SET status = ?, assigned_role = CASE WHEN ? = "Escalated" THEN "STRO" ELSE assigned_role END, escalation_destination = CASE WHEN ? = "Escalated" THEN "STRO" ELSE escalation_destination END, referred_to_stro_at = CASE WHEN ? = "Escalated" THEN CURRENT_TIMESTAMP ELSE referred_to_stro_at END, referred_to_stro_by = CASE WHEN ? = "Escalated" THEN ? ELSE referred_to_stro_by END, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, selected.status, selected.status, selected.status, selected.status, req.session.user.id, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  if (selected.status === 'Escalated') {
    await database.execute(
      `INSERT INTO str_reports (
        str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
        supporting_evidence, senior_analyst_notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE str_status = str_status`,
      [id('STR'), caseRow.transaction_id, req.params.id, 'Possible suspicious activity', notes || selected.label, JSON.stringify(['Transaction behaviour']), notes || selected.label],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/senior-analyst/cases');
});

app.post('/stro/cases/:id/action', requireRole('STRO'), async (req, res) => {
  const action = String(req.body.action || '').trim();
  const notes = String(req.body.notes || '').trim();
  const [rows] = await database.query('SELECT transaction_id FROM cases WHERE case_id = ? LIMIT 1', [req.params.id]);
  const caseRow = rows[0];
  if (!caseRow) return res.redirect('/stro/cases');

  const actionMap = {
    dismiss: { status: 'Dismissed as False Positive', actionStatus: 'Dismissed as False Positive', label: 'Dismissed as False Positive' },
    str: { status: 'STR Filed', actionStatus: 'STR Filed', label: 'STR Filed' },
  };
  const selected = actionMap[action];
  if (!selected) return res.redirect('/stro/cases');

  await database.execute('UPDATE cases SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE case_id = ?', [selected.status, notes || null, req.params.id]);
  await database.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', [selected.actionStatus, caseRow.transaction_id]);
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), caseRow.transaction_id, selected.label, req.session.user.id, notes || selected.label],
  );

  return res.redirect('/stro/cases');
});

// Small connection-status + live-refresh script (replaces the old dashboard/analytics SPA
// bundle that used to live here). Any page with a [data-live-refresh] element soft-reloads
// shortly after a new transaction event, so live pages reflect ingestion without polling.
app.get('/app.js', (req, res) => {
  res.type('application/javascript');
  res.send(`(function () {
  var dot = document.querySelector('#connectionDot');
  var text = document.querySelector('#connectionText');
  var stream = new EventSource('/api/stream');
  var refreshTimer = null;

  stream.addEventListener('open', function () {
    if (dot) dot.classList.add('online');
    if (text) text.textContent = 'Live stream connected';
  });

  stream.addEventListener('error', function () {
    if (dot) dot.classList.remove('online');
    if (text) text.textContent = 'Reconnecting';
  });

  stream.addEventListener('transaction', function () {
    if (!document.querySelector('[data-live-refresh]')) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      window.location.reload();
    }, 1200);
  });
})();`);
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

// Real-time ingestion entry point: this is what makes the system "live" - a transaction only
// ever appears because something actually called this (the historical import script, or a
// real upstream feed/form), never because of a background generator.
app.post('/api/transactions', async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!req.body.merchantId) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  try {
    const [merchantRows] = await database.query(
      'SELECT merchant_country, risk_tier FROM merchants WHERE merchant_id = ?',
      [req.body.merchantId],
    );
    const merchant = merchantRows[0]
      ? { merchantCountry: merchantRows[0].merchant_country, riskTier: merchantRows[0].risk_tier }
      : { merchantCountry: 'SG', riskTier: 'Standard' };

    const raw = {
      id: req.body.id || id('TXN'),
      merchantId: req.body.merchantId,
      storeId: req.body.storeId || null,
      amount,
      method: req.body.method || 'card',
      scheme: req.body.scheme || null,
      issuer: req.body.issuer || null,
      transactionType: req.body.transactionType || 'sale',
      entryMode: req.body.entryMode || 'manual',
      status: req.body.status || 'captured',
      statusLabel: req.body.statusLabel || 'Captured',
      statusTone: req.body.statusTone || 'success',
      net: req.body.net ?? amount,
      fee: req.body.fee ?? 0,
      txnTime: req.body.txnTime ? new Date(req.body.txnTime) : new Date(),
      note: req.body.note || null,
    };

    const evaluation = await ingestTransaction(database, raw, merchant, { broadcast });
    return res.status(201).json({ transactionId: raw.id, ...evaluation });
  } catch (error) {
    console.error('Transaction ingestion failed', { message: error.message });
    return res.status(500).json({ error: 'Unable to ingest transaction' });
  }
});

app.post('/api/transactions/:id/rfi', (req, res) => handleDatabaseRfiRequest(req, res));

app.patch('/api/transactions/:id/resolve', (req, res) => handleDatabaseResolveRequest(req, res));

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

async function startServer() {
  await database.initDatabase();
  await database.ensurePartnerSchema();

  const server = app.listen(PORT, () => {
    console.log(`UNIWEB local (domestic) card-payment monitoring running on http://localhost:${PORT} - any Singapore merchant profile, MCC-driven risk classification`);
  });

  server.on('error', (error) => {
    console.error(`Server failed to listen on port ${PORT}: ${error.message}`);
    process.exit(1);
  });

  setInterval(() => {
    autoAssignStaleCriticalCases().catch((error) => {
      console.error(`Stale case auto-assign failed: ${error.message}`);
    });
  }, 60 * 1000);
}

app.locals.assignmentHelpers = {
  addWorkingDays,
};
app.locals.strWorkflowHelpers = {
  validateStrTransition,
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}

module.exports = app;
