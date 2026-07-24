const database = require('../src/database');

// Column names are chosen by the caller (cddChecklist.js's FIELD_DEFS) since each checklist
// field writes to a different column pair - accepts an optional db client so callers that
// inject their own (controllers pass the real database; tests can pass a fake) share this seam.
async function upsertField(db, {
  transactionId, merchantId, completedColumn, notesColumn, byColumn, atColumn, completed, notes, userId,
}) {
  const client = db || database;
  await client.execute(
    `INSERT INTO merchant_cdd_checklist (transaction_id, merchant_id, ${completedColumn}, ${notesColumn}, ${byColumn}, ${atColumn})
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       ${completedColumn} = VALUES(${completedColumn}),
       ${notesColumn} = VALUES(${notesColumn}),
       ${byColumn} = VALUES(${byColumn}),
       ${atColumn} = VALUES(${atColumn})`,
    [transactionId, merchantId, completed ? 1 : 0, notes || null, userId],
  );
}

module.exports = { upsertField };
