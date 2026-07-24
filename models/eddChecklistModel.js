const database = require('../src/database');

async function findByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT source_of_funds_verified, site_visit_completed, enhanced_verification_completed
     FROM merchant_edd_checklist WHERE transaction_id = ? LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

// Column names are chosen by the caller (eddChecklist.js's FIELD_DEFS). Accepts an optional db
// client so controllers (real database) and tests (a fake) share this seam.
async function upsertField(db, {
  transactionId, merchantId, completedColumn, notesColumn, byColumn, atColumn, completed, notes, userId,
}) {
  const client = db || database;
  await client.execute(
    `INSERT INTO merchant_edd_checklist (transaction_id, merchant_id, ${completedColumn}, ${notesColumn}, ${byColumn}, ${atColumn})
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       ${completedColumn} = VALUES(${completedColumn}),
       ${notesColumn} = VALUES(${notesColumn}),
       ${byColumn} = VALUES(${byColumn}),
       ${atColumn} = VALUES(${atColumn})`,
    [transactionId, merchantId, completed ? 1 : 0, notes || null, userId],
  );
}

module.exports = { findByTransactionId, upsertField };
