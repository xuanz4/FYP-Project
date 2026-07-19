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
  database: process.env.DB_NAME || 'fyp_transaction_monitoring_test',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
};

let pool = null;
let enabled = false;

async function query(sql, params = []) {
  if (!enabled) {
    throw new Error('Database is not enabled');
  }

  return pool.query(sql, params);
}

async function execute(sql, params = []) {
  if (!enabled) {
    throw new Error('Database is not enabled');
  }

  return pool.execute(sql, params);
}

async function withTransaction(callback) {
  if (!enabled) throw new Error('Database is not enabled');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback({
      query: (sql, params = []) => connection.query(sql, params),
      execute: (sql, params = []) => connection.execute(sql, params),
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function isEnabled() {
  return enabled;
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
    console.warn('Run FYP_Transaction_Monitoring_test.sql in MySQL, then set DB_USER/DB_PASSWORD if needed.');
    enabled = false;
    return false;
  }
}

// Partner-provided transaction feed is shaped like a PSP/acquirer transaction log
// (merchant + card scheme/issuer + entry mode), not a card-issuer/cardholder record, so it
// carries no PAN/CVV. The old card_number/card_expiry/bin_range/cvv/bank_issuer columns were
// only ever filled with randomly-generated placeholder values and are dropped here. Idempotent
// and safe to call on every startup, following the same pattern as app.js's ensureXxxColumns().
async function ensurePartnerSchema() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !enabled) return;

  const [transactionColumns] = await query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions'`,
    [dbName],
  );
  const hasTxnColumn = (column) => transactionColumns.some((row) => row.COLUMN_NAME === column);

  const newTransactionColumns = [
    ['store_id', 'ALTER TABLE transactions ADD COLUMN store_id VARCHAR(30) NULL AFTER merchant_id'],
    ['method', 'ALTER TABLE transactions ADD COLUMN method VARCHAR(20) NULL AFTER amount'],
    ['scheme', 'ALTER TABLE transactions ADD COLUMN scheme VARCHAR(20) NULL AFTER method'],
    ['issuer_country', 'ALTER TABLE transactions ADD COLUMN issuer_country VARCHAR(5) NULL AFTER scheme'],
    ['transaction_type', 'ALTER TABLE transactions ADD COLUMN transaction_type VARCHAR(20) NULL AFTER issuer_country'],
    ['entry_mode', 'ALTER TABLE transactions ADD COLUMN entry_mode VARCHAR(20) NULL AFTER transaction_type'],
    ['payment_status', 'ALTER TABLE transactions ADD COLUMN payment_status VARCHAR(20) NULL AFTER entry_mode'],
    ['payment_status_label', 'ALTER TABLE transactions ADD COLUMN payment_status_label VARCHAR(30) NULL AFTER payment_status'],
    ['payment_status_tone', 'ALTER TABLE transactions ADD COLUMN payment_status_tone VARCHAR(20) NULL AFTER payment_status_label'],
    ['net', 'ALTER TABLE transactions ADD COLUMN net DECIMAL(10,2) NULL AFTER payment_status_tone'],
    ['fee', 'ALTER TABLE transactions ADD COLUMN fee DECIMAL(10,2) NULL AFTER net'],
    ['txn_time', 'ALTER TABLE transactions ADD COLUMN txn_time DATETIME NULL AFTER fee'],
    ['source_note', 'ALTER TABLE transactions ADD COLUMN source_note VARCHAR(255) NULL AFTER txn_time'],
  ];
  for (const [column, sql] of newTransactionColumns) {
    if (!hasTxnColumn(column)) await execute(sql);
  }

  const legacyCardColumns = ['card_number', 'card_expiry', 'bin_range', 'cvv', 'bank_issuer'];
  for (const column of legacyCardColumns) {
    if (hasTxnColumn(column)) await execute(`ALTER TABLE transactions DROP COLUMN ${column}`);
  }

  const [merchantColumns] = await query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'merchants'`,
    [dbName],
  );
  const hasMerchantColumn = (column) => merchantColumns.some((row) => row.COLUMN_NAME === column);

  if (!hasMerchantColumn('merchant_mid')) {
    await execute('ALTER TABLE merchants ADD COLUMN merchant_mid VARCHAR(30) NULL AFTER merchant_name');
  }
  if (!hasMerchantColumn('merchant_country')) {
    await execute('ALTER TABLE merchants ADD COLUMN merchant_country VARCHAR(5) NULL AFTER merchant_mid');
  }
  if (!hasMerchantColumn('risk_tier')) {
    await execute("ALTER TABLE merchants ADD COLUMN risk_tier ENUM('Standard', 'High') NOT NULL DEFAULT 'Standard' AFTER mcc_risk_score");
  }
  if (!hasMerchantColumn('authorised_contact_name')) {
    await execute('ALTER TABLE merchants ADD COLUMN authorised_contact_name VARCHAR(100) NULL AFTER merchant_country');
  }
  if (!hasMerchantColumn('authorised_contact_email')) {
    await execute('ALTER TABLE merchants ADD COLUMN authorised_contact_email VARCHAR(255) NULL AFTER authorised_contact_name');
  }
}

module.exports = {
  initDatabase,
  isEnabled,
  ensurePartnerSchema,
  query,
  execute,
  withTransaction,
};
