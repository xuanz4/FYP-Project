const database = require('../src/database');

async function insert({
  auditId, transactionId = null, entityType = null, entityId = null, action, userId = null, notes = null,
}, db = database) {
  await db.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [auditId, transactionId, entityType, entityId, action, userId, notes],
  );
}

async function listByTransactionId(transactionId) {
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action, al.user_id, al.notes, al.created_at,
            u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     WHERE al.transaction_id = ?
     ORDER BY al.created_at ASC`,
    [transactionId],
  );
  return rows;
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(
    `SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`,
    values,
  );
  return Number(rows[0]?.total || 0);
}

async function listFiltered(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function listDistinctActions() {
  const [rows] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  return rows;
}

async function listDistinctEntityTypes() {
  const [rows] = await database.query("SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type ASC");
  return rows;
}

module.exports = {
  insert, listByTransactionId, countFiltered, listFiltered, listDistinctActions, listDistinctEntityTypes,
};
