const database = require('../database');
const { id } = require('./ids');

// Writes directly to the audit_logs row shape (transaction_id/user_id/notes) that the
// Admin/Analyst/STRO routes use.
async function logAdminAudit({
  action, userId, notes = null, transactionId = null, entityType = null, entityId = null,
}) {
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), transactionId, entityType, entityId, action, userId, notes],
  );
}

module.exports = { logAdminAudit };
