const database = require('../src/database');

async function listByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT tmr.rule_id, tmr.matched_at, cr.rule_name, cr.risk_level, cr.reason, cr.weight, cr.rule_type
     FROM transaction_matched_rules tmr
     LEFT JOIN compliance_rules cr ON cr.rule_id = tmr.rule_id
     WHERE tmr.transaction_id = ?
     ORDER BY tmr.matched_at ASC`,
    [transactionId],
  );
  return rows;
}

// transactionIngestion.js always passes its own db explicitly (the real database, or a test's
// fake) - one insert per matched rule, right after the transaction row itself is written.
async function recordMatch(db, transactionId, ruleId) {
  await db.execute(
    `INSERT INTO transaction_matched_rules (transaction_id, rule_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE matched_at = matched_at`,
    [transactionId, ruleId],
  );
}

module.exports = { listByTransactionId, recordMatch };
