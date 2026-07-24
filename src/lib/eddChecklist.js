// Shared write path for merchant_edd_checklist, one row per transaction (see schema.js's
// ensureMerchantCddSchema) - every transaction's case gets its own checklist, so completing it
// on one transaction never marks another transaction of the same merchant complete. Analysts
// maintain the baseline checks while Enhanced Verification and final sign-off are
// Senior-Analyst-only case-workspace actions. See resolveWorkflow.js's cddGateRequirement and
// merchantCdd.js's computeEddComplete for why senior_signoff_completed is kept structurally
// distinct from the other three items. Which fieldKey a caller may use is enforced by the
// caller (transactionsController.js), not here.
const eddChecklistModel = require('../../models/eddChecklistModel');

const FIELD_DEFS = {
  sourceOfFunds: {
    completed: 'source_of_funds_verified', notes: 'source_of_funds_notes', by: 'source_of_funds_by', at: 'source_of_funds_at',
  },
  siteVisit: {
    completed: 'site_visit_completed', notes: 'site_visit_notes', by: 'site_visit_by', at: 'site_visit_at',
  },
  enhancedVerification: {
    completed: 'enhanced_verification_completed', notes: 'enhanced_verification_notes', by: 'enhanced_verification_by', at: 'enhanced_verification_at',
  },
  seniorSignoff: {
    completed: 'senior_signoff_completed', notes: 'senior_signoff_notes', by: 'senior_signoff_by', at: 'senior_signoff_at',
  },
};

async function setEddChecklistField(db, {
  transactionId, merchantId, fieldKey, completed, notes, userId,
}) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) throw new Error(`Unknown EDD checklist field: ${fieldKey}`);
  if (!transactionId) throw new Error('transactionId is required to set an EDD checklist field');
  await eddChecklistModel.upsertField(db, {
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

module.exports = { setEddChecklistField, FIELD_DEFS };
