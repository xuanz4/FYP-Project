const database = require('../database');

function memoizeAsync(fn) {
  let inFlight = null;
  return (...args) => {
    if (!inFlight) {
      inFlight = fn(...args).catch((error) => {
        inFlight = null;
        throw error;
      });
    }
    return inFlight;
  };
}

const ensureDatabaseResolveColumns = memoizeAsync(async function ensureDatabaseResolveColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN ('transactions', 'cases')
       AND COLUMN_NAME IN ('final_risk_score', 'final_risk_level', 'decision', 'resolution_reason', 'analyst_notes', 'resolved_at', 'resolved_by')`,
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
  if (!hasColumn('cases', 'resolved_by')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolved_by VARCHAR(40) NULL AFTER resolved_at');
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
});

const ensureCaseAssignmentColumns = memoizeAsync(async function ensureCaseAssignmentColumns() {
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
});

const ensureStrWorkflowSchema = memoizeAsync(async function ensureStrWorkflowSchema() {
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
      str_status ENUM('Recommended', 'Filed', 'Not Required') NOT NULL DEFAULT 'Recommended',
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
});

// Real additive risk formula (MCC + Profile + Detection) needs each component persisted per
// transaction, plus a stable human-facing reference number - see riskEngine.js/transactionIngestion.js.
const ensureRiskContributionColumns = memoizeAsync(async function ensureRiskContributionColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions'
       AND COLUMN_NAME IN ('mcc_risk_contribution', 'profile_risk_contribution', 'transaction_detection_contribution', 'unique_transaction_reference')`,
    [dbName],
  );
  const hasColumn = (column) => columns.some((row) => row.COLUMN_NAME === column);

  if (!hasColumn('mcc_risk_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN mcc_risk_contribution INT NULL AFTER risk_level');
  }
  if (!hasColumn('profile_risk_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN profile_risk_contribution INT NULL AFTER mcc_risk_contribution');
  }
  if (!hasColumn('transaction_detection_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN transaction_detection_contribution INT NULL AFTER profile_risk_contribution');
  }
  if (!hasColumn('unique_transaction_reference')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN unique_transaction_reference VARCHAR(50) NULL AFTER transaction_id');
  }

  const [indexes] = await database.query(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND INDEX_NAME = 'uniq_unique_transaction_reference'`,
    [dbName],
  );
  if (!indexes.length) {
    await database.execute('ALTER TABLE transactions ADD UNIQUE INDEX uniq_unique_transaction_reference (unique_transaction_reference)');
  }
});

// One row per merchant MID summarising that merchant's history, so "Profile Risk" is a real
// computed number instead of always showing "Not stored". Written by transactionIngestion.js
// right after each transaction is ingested; read by riskEngine.js for the next transaction's
// profileRiskContribution.
const ensureMerchantRiskProfileTable = memoizeAsync(async function ensureMerchantRiskProfileTable() {
  if (!database.isEnabled()) return;
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_risk_profiles (
      merchant_mid VARCHAR(30) PRIMARY KEY,
      merchant_id VARCHAR(20) NULL,
      merchant_name VARCHAR(100) NULL,
      transaction_count INT NOT NULL DEFAULT 0,
      flagged_transaction_count INT NOT NULL DEFAULT 0,
      flagged_transaction_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      declined_transaction_count INT NOT NULL DEFAULT 0,
      total_transaction_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      average_transaction_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      maximum_transaction_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      rule_trigger_count INT NOT NULL DEFAULT 0,
      escalation_count INT NOT NULL DEFAULT 0,
      confirmed_suspicious_case_count INT NOT NULL DEFAULT 0,
      profile_risk_score INT NOT NULL DEFAULT 0,
      profile_risk_level VARCHAR(30) NOT NULL DEFAULT 'Insufficient History',
      profile_risk_reasons TEXT NULL,
      first_seen_at DATETIME NULL,
      last_seen_at DATETIME NULL,
      risk_last_calculated_at DATETIME NULL,
      INDEX idx_merchant_risk_profiles_merchant_id (merchant_id)
    )`,
  );
});

// Auditable merchant contact record, replacing the single mutable merchants.authorised_contact_*
// columns. Always queried live (never cached) by the RFI workflow and the transaction detail
// page, so an Admin's edit here takes effect immediately with no other code change.
const ensureMerchantContactsTable = memoizeAsync(async function ensureMerchantContactsTable() {
  if (!database.isEnabled()) return;
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_contacts (
      contact_id VARCHAR(40) PRIMARY KEY,
      merchant_id VARCHAR(20) NOT NULL,
      merchant_mid VARCHAR(30) NULL,
      store_id VARCHAR(30) NULL,
      contact_name VARCHAR(100) NULL,
      rfi_email VARCHAR(255) NULL,
      phone_number VARCHAR(30) NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      updated_by VARCHAR(20) NULL,
      updated_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_merchant_contacts_merchant (merchant_id),
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
    )`,
  );

  // One-time backfill: merchants.authorised_contact_name/email is the legacy single mutable
  // field this table replaces. Admin edits now only ever touch merchant_contacts, so any
  // pre-existing legacy value needs to land here once, or it becomes invisible to the RFI
  // workflow and the transaction detail page (both read merchant_contacts exclusively) even
  // though it's still sitting on the merchants row. Only copies where no merchant_contacts row
  // exists yet, so it never clobbers a value someone has already entered the new way.
  await database.execute(
    `INSERT INTO merchant_contacts (contact_id, merchant_id, merchant_mid, contact_name, rfi_email, status, updated_at)
     SELECT CONCAT('MCT-BACKFILL-', m.merchant_id), m.merchant_id, m.merchant_mid, m.authorised_contact_name, m.authorised_contact_email, 'Active', NOW()
     FROM merchants m
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = m.merchant_id
     WHERE mc.merchant_id IS NULL
       AND (m.authorised_contact_name IS NOT NULL OR m.authorised_contact_email IS NOT NULL)`,
  );
});

// Optional manual reconciliation entered by the resolver, compared against the transaction's
// stored automated contributions/score to catch false positives or calculation errors.
const ensureCaseReconciliationColumns = memoizeAsync(async function ensureCaseReconciliationColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('manual_mcc_contribution', 'manual_profile_contribution', 'manual_detection_contribution', 'manual_final_score', 'discrepancy_flag', 'discrepancy_notes')`,
    [dbName],
  );
  const hasColumn = (column) => columns.some((row) => row.COLUMN_NAME === column);

  if (!hasColumn('manual_mcc_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_mcc_contribution INT NULL AFTER resolved_by');
  }
  if (!hasColumn('manual_profile_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_profile_contribution INT NULL AFTER manual_mcc_contribution');
  }
  if (!hasColumn('manual_detection_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_detection_contribution INT NULL AFTER manual_profile_contribution');
  }
  if (!hasColumn('manual_final_score')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_final_score INT NULL AFTER manual_detection_contribution');
  }
  if (!hasColumn('discrepancy_flag')) {
    await database.execute('ALTER TABLE cases ADD COLUMN discrepancy_flag TINYINT(1) NULL AFTER manual_final_score');
  }
  if (!hasColumn('discrepancy_notes')) {
    await database.execute('ALTER TABLE cases ADD COLUMN discrepancy_notes TEXT NULL AFTER discrepancy_flag');
  }
});

// Single call site for every ensure* above - covers the risk-formula, merchant-profile,
// merchant-contacts and case-reconciliation schema in one idempotent pass.
const ensureRiskAndContactSchema = memoizeAsync(async function ensureRiskAndContactSchema() {
  await ensureRiskContributionColumns();
  await ensureMerchantRiskProfileTable();
  await ensureMerchantContactsTable();
  await ensureCaseReconciliationColumns();
});

module.exports = {
  ensureDatabaseResolveColumns,
  ensureCaseAssignmentColumns,
  ensureStrWorkflowSchema,
  ensureMerchantContactsTable,
  ensureRiskAndContactSchema,
};
