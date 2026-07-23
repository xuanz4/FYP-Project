// Shared write path for merchant_cdd_checklist, one row per transaction (see schema.js's
// ensureMerchantCddSchema) - every transaction's case gets its own CDD checklist, required
// regardless of risk level. Mirrors eddChecklist.js's shape exactly. Which fieldKey a caller may
// use is enforced by the caller (transactionsController.js), not here.
const database = require('../database');

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
  const client = db || database;
  await client.execute(
    `INSERT INTO merchant_cdd_checklist (transaction_id, merchant_id, ${def.completed}, ${def.notes}, ${def.by}, ${def.at})
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       ${def.completed} = VALUES(${def.completed}),
       ${def.notes} = VALUES(${def.notes}),
       ${def.by} = VALUES(${def.by}),
       ${def.at} = VALUES(${def.at})`,
    [transactionId, merchantId, completed ? 1 : 0, notes || null, userId],
  );
}

module.exports = { setCddChecklistField, FIELD_DEFS };
