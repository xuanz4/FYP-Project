// Shared write path for merchant_edd_checklist, used both by Admin (can set any field) and the
// case workspace (Analyst may only set sourceOfFunds/siteVisit; senior sign-off is a separate,
// Senior-Analyst/Admin-only write path) - see resolveWorkflow.js's cddGateRequirement and
// merchantCdd.js's computeEddComplete for why senior_signoff_completed is kept structurally
// distinct from the other three items. Which fieldKey a caller may use is enforced by the
// caller (adminController.js / transactionsController.js), not here.
const database = require('../database');

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
  merchantId, fieldKey, completed, notes, userId,
}) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) throw new Error(`Unknown EDD checklist field: ${fieldKey}`);
  const client = db || database;
  await client.execute(
    `INSERT INTO merchant_edd_checklist (merchant_id, ${def.completed}, ${def.notes}, ${def.by}, ${def.at})
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       ${def.completed} = VALUES(${def.completed}),
       ${def.notes} = VALUES(${def.notes}),
       ${def.by} = VALUES(${def.by}),
       ${def.at} = VALUES(${def.at})`,
    [merchantId, completed ? 1 : 0, notes || null, userId],
  );
}

module.exports = { setEddChecklistField, FIELD_DEFS };
