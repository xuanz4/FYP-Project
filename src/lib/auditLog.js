const auditLogModel = require('../../models/auditLogModel');
const { id } = require('./ids');

// Writes directly to the audit_logs row shape (transaction_id/user_id/notes) that the
// Admin/Analyst/STRO routes use.
async function logAdminAudit({
  action, userId, notes = null, transactionId = null, entityType = null, entityId = null,
}, db) {
  await auditLogModel.insert({
    auditId: id('AUD'), transactionId, entityType, entityId, action, userId, notes,
  }, db);
}

module.exports = { logAdminAudit };
