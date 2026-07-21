// Wipes every transactional record (transactions, cases, matched rules, STR reports, merchant
// risk profiles, and their audit_logs entries) and reloads from the test-data workbook, running
// every row back through the exact same ingestTransaction() pipeline live traffic uses. There is
// no separate "recalculation formula" - the risk score, reference number and merchant profile
// for every row (old or new) come from that one code path, never a patched-in-place UPDATE.
//
// Merchants, merchant_contacts and compliance_rules are NOT wiped - they're reference/config
// data, not transactional history. compliance_rules thresholds are recomputed (upserted) from
// the new transaction amounts by seedTestData, same as the very first import.
require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const fs = require('fs');
const database = require('../src/database');

const WORKBOOK_PATH = process.env.RESET_RELOAD_XLSX_PATH
  || 'C:\\Republic Poly\\AY 26 Semester 1\\C300 Final Year Project\\Test Data\\Data for FYP.xlsx';
const FIXTURE_PATH = path.join(__dirname, 'data', 'partnerTransactions.json');

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function convertWorkbookToPartnerJson(workbookPath) {
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const transactions = rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    merchantMid: row.merchant_mid,
    merchantCountry: row.merchant_country,
    storeId: row.store_id,
    amount: Number(row.amount),
    method: row.method,
    scheme: row.scheme,
    issuer: row.issuer,
    transactionType: row.transaction_type,
    entryMode: row.entry_mode,
    status: row.status,
    statusLabel: row.status_label,
    statusTone: row.status_tone,
    net: row.net === null ? null : Number(row.net),
    fee: row.fee === null ? null : Number(row.fee),
    txnTime: toIsoString(row.txn_time),
    note: row.note,
  }));

  if (!transactions.length) {
    throw new Error(`No rows found in workbook: ${workbookPath}`);
  }

  // Ingested in chronological order so reference numbers, merchant risk profiles and rule
  // velocity signals all build up the same way they would from genuine live traffic.
  transactions.sort((a, b) => new Date(a.txnTime).getTime() - new Date(b.txnTime).getTime());
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(transactions, null, 2)}\n`, 'utf8');
  return transactions.length;
}

// audit_logs is deliberately append-only (audit_logs_no_delete/no_update triggers reject any
// DELETE/UPDATE) - a real compliance control, not incidental. A full wipe still needs to clear
// out transaction/case-scoped entries here, so the no-delete trigger is dropped and recreated
// around just this one statement; every other table's append-only guarantee is untouched, and
// the trigger is back in place before this function returns.
async function wipeTransactionalData() {
  // DDL (CREATE/DROP TRIGGER) is not supported over the prepared-statement protocol that
  // database.execute() uses - database.query() (text protocol) is what dbProvision.js already
  // uses for this exact kind of statement when first creating the schema.
  await database.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await database.query('TRUNCATE TABLE str_reports');
    await database.query('TRUNCATE TABLE transaction_matched_rules');
    await database.query('TRUNCATE TABLE cases');

    await database.query('DROP TRIGGER IF EXISTS audit_logs_no_delete');
    try {
      await database.query(
        "DELETE FROM audit_logs WHERE transaction_id IS NOT NULL OR entity_type IN ('Case', 'Transaction')",
      );
    } finally {
      await database.query(`CREATE TRIGGER audit_logs_no_delete
        BEFORE DELETE ON audit_logs
        FOR EACH ROW
        BEGIN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only and cannot be deleted';
        END`);
    }

    await database.query('TRUNCATE TABLE merchant_risk_profiles');
    await database.query('TRUNCATE TABLE transactions');
  } finally {
    await database.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function main() {
  const connected = await database.initDatabase();
  if (!connected) throw new Error('Could not connect to the database - check .env DB_* settings.');
  await database.ensurePartnerSchema();
  const { ensureRiskAndContactSchema, ensureStrWorkflowSchema, ensureDatabaseResolveColumns } = require('../src/lib/schema');
  await ensureRiskAndContactSchema();
  await ensureStrWorkflowSchema();
  await ensureDatabaseResolveColumns();

  const rowCount = convertWorkbookToPartnerJson(WORKBOOK_PATH);
  console.log(`Converted ${rowCount} rows from workbook into ${FIXTURE_PATH}.`);

  console.log('Wiping existing transactions, cases, matched rules, STR reports and merchant risk profiles...');
  await wipeTransactionalData();

  // Fresh require so the just-rewritten fixture file is what gets loaded, not a stale
  // in-process cache from an earlier require of this module.
  delete require.cache[require.resolve('./data/partnerTransactions.json')];
  delete require.cache[require.resolve('../src/lib/testDataSeed')];
  const { seedTestData } = require('../src/lib/testDataSeed');

  const result = await seedTestData(database);
  if (!result.seeded) {
    throw new Error('Reload did not run - transactions table was not empty after wipe.');
  }
  console.log(`Reloaded ${result.imported} transactions, ${result.flagged} flagged (cases auto-opened by DB trigger).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Reset and reload failed:', error);
    process.exit(1);
  });
