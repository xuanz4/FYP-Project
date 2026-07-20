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

module.exports = {
  ensureDatabaseResolveColumns,
  ensureCaseAssignmentColumns,
  ensureStrWorkflowSchema,
};
