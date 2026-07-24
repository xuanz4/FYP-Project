// Shared write path for merchant_cdd_checklist, one row per transaction (see schema.js's
// ensureMerchantCddSchema) - every transaction's case gets its own CDD checklist, required
// regardless of risk level. Mirrors eddChecklist.js's shape exactly. Which fieldKey a caller may
// use is enforced by the caller (transactionsController.js), not here.
const cddChecklistModel = require('../../models/cddChecklistModel');

const FIELD_DEFS = {
  businessRegistration: {
    completed: 'business_registration_verified', notes: 'business_registration_notes', by: 'business_registration_by', at: 'business_registration_at',
  },
  screening: {
    completed: 'screening_verified', notes: 'screening_notes', by: 'screening_by', at: 'screening_at',
  },
};

async function setCddChecklistField(db, {
  transactionId, merchantId, fieldKey, completed, notes, userId,
}) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) throw new Error(`Unknown CDD checklist field: ${fieldKey}`);
  if (!transactionId) throw new Error('transactionId is required to set a CDD checklist field');
  await cddChecklistModel.upsertField(db, {
    transactionId,
    merchantId,
    completedColumn: def.completed,
    notesColumn: def.notes,
    byColumn: def.by,
    atColumn: def.at,
    completed,
    notes,
    userId,
  });
}

module.exports = { setCddChecklistField, FIELD_DEFS };
