// Loads a merchant's self-declared KYC baseline (merchant-level reference data, feeds the risk
// engine's declared-ticket/operating-hours/expected-countries thresholds - see riskEngine.js)
// plus a transaction's own CDD and EDD checklists (see schema.js's ensureMerchantCddSchema for
// the underlying tables). Mirrors merchantRiskProfile.js's shape: a single read function other
// modules call, so riskEngine/transactionIngestion, the resolve workflow gate, and the case
// workspace view all agree on one definition of "complete".
const database = require('../database');

function parseExpectedCountries(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

function isReviewOverdue(nextReviewDate) {
  if (!nextReviewDate) return false;
  return new Date(nextReviewDate).getTime() < Date.now();
}

// eddComplete requires every checklist item true, including senior_signoff_completed - which
// only a Senior Analyst write path ever sets (see the case workspace sign-off endpoint) - so an
// Analyst alone can never satisfy this on their own. checklist is loaded per-transaction (see
// loadMerchantCddContext's transactionId param), never merchant-wide.
function computeEddComplete(checklist) {
  if (!checklist) return false;
  return Boolean(
    checklist.source_of_funds_verified
    && checklist.site_visit_completed
    && checklist.enhanced_verification_completed
    && checklist.senior_signoff_completed,
  );
}

function requiresEdd(_merchantRiskTier, transactionRiskLevel) {
  // Transaction-case EDD is triggered only by the transaction's assessed risk. The stored
  // merchant tier remains profile context and must not force a Medium/Low case into EDD.
  return ['High', 'Critical'].includes(transactionRiskLevel);
}

// CDD completion is the baseline every transaction's case must clear, regardless of risk level -
// both steps (Business Registration, Screening) confirmed by an Analyst against that
// transaction's own checklist row (see cddChecklist.js), never against the merchant's KYC
// baseline profile - a merchant's shared KYC Status/Verification Date is reference context for
// the risk engine, not something one transaction's due diligence can satisfy for another.
function computeCddComplete(checklist) {
  if (!checklist) return false;
  return Boolean(checklist.business_registration_verified && checklist.screening_verified);
}

async function loadMerchantCddContext(db, merchantId, { transactionRiskLevel = null, transactionId = null } = {}) {
  const client = db || database;
  // isEnabled() guards the singleton-database fallback (an unconfigured/disconnected pool);
  // callers that inject their own client (transactionIngestion.js's real database param, or a
  // test's fake) don't need to implement it - absence of the method just means "usable".
  const enabled = typeof client.isEnabled !== 'function' || client.isEnabled();
  if (!merchantId || !enabled) {
    return {
      kycStatus: 'Not Started',
      verificationDate: null,
      nextReviewDate: null,
      reviewOverdue: false,
      expectedAvgTicket: null,
      expectedMonthlyVolume: null,
      expectedCountries: [],
      expectedOperatingHours: null,
      cddComplete: false,
      cddChecklist: null,
      eddRequired: requiresEdd(null, transactionRiskLevel),
      eddComplete: false,
      eddChecklist: null,
    };
  }

  const [[merchantRow], [profileRows], [cddChecklistRows], [eddChecklistRows]] = await Promise.all([
    client.query('SELECT risk_tier FROM merchants WHERE merchant_id = ? LIMIT 1', [merchantId]),
    client.query(
      `SELECT kyc_status, verification_date, next_review_date, expected_avg_ticket,
              expected_monthly_volume, expected_countries,
              expected_operating_open_hour, expected_operating_close_hour
       FROM merchant_cdd_profiles WHERE merchant_id = ? LIMIT 1`,
      [merchantId],
    ),
    transactionId
      ? client.query(
        `SELECT business_registration_verified, business_registration_notes, business_registration_by, business_registration_at,
                screening_verified, screening_notes, screening_by, screening_at
         FROM merchant_cdd_checklist WHERE transaction_id = ? LIMIT 1`,
        [transactionId],
      )
      : Promise.resolve([[]]),
    transactionId
      ? client.query(
        `SELECT source_of_funds_verified, source_of_funds_notes, source_of_funds_by, source_of_funds_at,
                site_visit_completed, site_visit_notes, site_visit_by, site_visit_at,
                enhanced_verification_completed, enhanced_verification_notes, enhanced_verification_by, enhanced_verification_at,
                senior_signoff_completed, senior_signoff_notes, senior_signoff_by, senior_signoff_at
         FROM merchant_edd_checklist WHERE transaction_id = ? LIMIT 1`,
        [transactionId],
      )
      : Promise.resolve([[]]),
  ]);

  const merchant = merchantRow[0];
  const profile = profileRows[0] || null;
  const cddChecklist = cddChecklistRows[0] || null;
  const eddChecklist = eddChecklistRows[0] || null;
  const eddRequired = requiresEdd(merchant?.risk_tier, transactionRiskLevel);
  const openHour = profile?.expected_operating_open_hour;
  const closeHour = profile?.expected_operating_close_hour;

  return {
    kycStatus: profile?.kyc_status || 'Not Started',
    verificationDate: profile?.verification_date || null,
    nextReviewDate: profile?.next_review_date || null,
    reviewOverdue: isReviewOverdue(profile?.next_review_date),
    expectedAvgTicket: profile?.expected_avg_ticket !== undefined && profile?.expected_avg_ticket !== null
      ? Number(profile.expected_avg_ticket) : null,
    expectedMonthlyVolume: profile?.expected_monthly_volume !== undefined && profile?.expected_monthly_volume !== null
      ? Number(profile.expected_monthly_volume) : null,
    expectedCountries: parseExpectedCountries(profile?.expected_countries),
    expectedOperatingHours: (openHour !== undefined && openHour !== null && closeHour !== undefined && closeHour !== null)
      ? { openHour: Number(openHour), closeHour: Number(closeHour) } : null,
    cddComplete: computeCddComplete(cddChecklist),
    cddChecklist,
    eddRequired,
    eddComplete: computeEddComplete(eddChecklist),
    eddChecklist,
  };
}

module.exports = {
  loadMerchantCddContext,
  computeEddComplete,
  computeCddComplete,
  isReviewOverdue,
  parseExpectedCountries,
  requiresEdd,
};
