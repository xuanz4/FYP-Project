const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  loadMerchantCddContext,
  computeEddComplete,
  computeCddComplete,
  isReviewOverdue,
  parseExpectedCountries,
  requiresEdd,
} = require('../src/lib/merchantCdd');

function fakeDatabase({
  merchant = null,
  profile = null,
  cddChecklist = null,
  eddChecklist = null,
  cddChecklistsByTransaction = null,
  eddChecklistsByTransaction = null,
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT risk_tier FROM merchants/.test(sql)) return [merchant ? [merchant] : []];
      if (/FROM merchant_cdd_profiles/.test(sql)) return [profile ? [profile] : []];
      if (/FROM merchant_cdd_checklist/.test(sql)) {
        assert.match(sql, /WHERE transaction_id = \?/, 'the CDD checklist must be looked up by transaction_id, not merchant_id, or it leaks across a merchant\'s other transactions');
        if (cddChecklistsByTransaction) {
          const row = cddChecklistsByTransaction[params[0]];
          return [row ? [row] : []];
        }
        return [cddChecklist ? [cddChecklist] : []];
      }
      if (/FROM merchant_edd_checklist/.test(sql)) {
        assert.match(sql, /WHERE transaction_id = \?/, 'the EDD checklist must be looked up by transaction_id, not merchant_id, or it leaks across a merchant\'s other transactions');
        if (eddChecklistsByTransaction) {
          const row = eddChecklistsByTransaction[params[0]];
          return [row ? [row] : []];
        }
        return [eddChecklist ? [eddChecklist] : []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

async function testReturnsDefaultsWhenNoMerchantId() {
  const context = await loadMerchantCddContext(fakeDatabase(), null);
  assert.strictEqual(context.kycStatus, 'Not Started');
  assert.strictEqual(context.cddComplete, false);
  assert.strictEqual(context.eddRequired, false);
  assert.strictEqual(context.eddComplete, false);
  assert.deepStrictEqual(context.expectedCountries, []);
}

async function testParsesExpectedActivityAndFlagsOverdueReview() {
  const database = fakeDatabase({
    merchant: { risk_tier: 'High' },
    profile: {
      kyc_status: 'Verified',
      verification_date: '2026-01-01',
      next_review_date: '2020-01-01',
      expected_avg_ticket: '150.50',
      expected_monthly_volume: '10000.00',
      expected_countries: 'sg, my ,id',
      expected_operating_open_hour: 8,
      expected_operating_close_hour: 20,
    },
    cddChecklist: {
      business_registration_verified: 1,
      screening_verified: 0,
    },
    eddChecklist: {
      source_of_funds_verified: 1,
      site_visit_completed: 1,
      enhanced_verification_completed: 0,
      senior_signoff_completed: 0,
    },
  });

  const context = await loadMerchantCddContext(database, 'M001', { transactionId: 'TXN-001' });
  assert.strictEqual(context.kycStatus, 'Verified');
  assert.strictEqual(context.reviewOverdue, true);
  assert.strictEqual(context.expectedAvgTicket, 150.5);
  assert.strictEqual(context.expectedMonthlyVolume, 10000);
  assert.deepStrictEqual(context.expectedCountries, ['SG', 'MY', 'ID']);
  assert.deepStrictEqual(context.expectedOperatingHours, { openHour: 8, closeHour: 20 });
  // CDD completion is unaffected by the merchant's KYC baseline (kyc_status: 'Verified' above) -
  // it comes purely from this transaction's own checklist, which is incomplete here.
  assert.strictEqual(context.cddComplete, false);
  assert.strictEqual(context.eddRequired, false);
  assert.strictEqual(context.eddComplete, false);
}

function testComputeEddCompleteRequiresAllFourIncludingSignoff() {
  assert.strictEqual(computeEddComplete(null), false);
  assert.strictEqual(computeEddComplete({
    source_of_funds_verified: 1, site_visit_completed: 1, enhanced_verification_completed: 1, senior_signoff_completed: 0,
  }), false);
  assert.strictEqual(computeEddComplete({
    source_of_funds_verified: 1, site_visit_completed: 1, enhanced_verification_completed: 1, senior_signoff_completed: 1,
  }), true);
}

function testComputeCddCompleteRequiresBothSteps() {
  assert.strictEqual(computeCddComplete(null), false);
  assert.strictEqual(computeCddComplete({ business_registration_verified: 1, screening_verified: 0 }), false);
  assert.strictEqual(computeCddComplete({ business_registration_verified: 0, screening_verified: 1 }), false);
  assert.strictEqual(computeCddComplete({ business_registration_verified: 1, screening_verified: 1 }), true);
}

function testIsReviewOverdue() {
  assert.strictEqual(isReviewOverdue(null), false);
  assert.strictEqual(isReviewOverdue('2000-01-01'), true);
  assert.strictEqual(isReviewOverdue('2999-01-01'), false);
}

function testParseExpectedCountries() {
  assert.deepStrictEqual(parseExpectedCountries(''), []);
  assert.deepStrictEqual(parseExpectedCountries(null), []);
  assert.deepStrictEqual(parseExpectedCountries('sg,  my,ID'), ['SG', 'MY', 'ID']);
}

function testHighAndCriticalTransactionsRequireEdd() {
  assert.strictEqual(requiresEdd('Standard', 'High'), true);
  assert.strictEqual(requiresEdd('Standard', 'Critical'), true);
  assert.strictEqual(requiresEdd('High', 'Medium'), false);
  assert.strictEqual(requiresEdd('Standard', 'Medium'), false);
  assert.strictEqual(requiresEdd('Standard', 'Low'), false);
}

async function testStandardMerchantHighTransactionRequiresEdd() {
  const database = fakeDatabase({ merchant: { risk_tier: 'Standard' } });
  const context = await loadMerchantCddContext(database, 'M002', { transactionRiskLevel: 'High' });
  assert.strictEqual(context.eddRequired, true);
}

// Regression test for the bug where completing the checklist on one transaction's case
// silently marked every other transaction of the same merchant as EDD-complete too.
async function testEddChecklistIsIsolatedPerTransaction() {
  const completeChecklist = {
    source_of_funds_verified: 1, site_visit_completed: 1, enhanced_verification_completed: 1, senior_signoff_completed: 1,
  };
  const database = fakeDatabase({
    merchant: { risk_tier: 'Standard' },
    eddChecklistsByTransaction: { 'TXN-COMPLETE': completeChecklist },
  });

  const completedContext = await loadMerchantCddContext(database, 'M003', {
    transactionRiskLevel: 'High', transactionId: 'TXN-COMPLETE',
  });
  assert.strictEqual(completedContext.eddComplete, true);

  const otherContext = await loadMerchantCddContext(database, 'M003', {
    transactionRiskLevel: 'High', transactionId: 'TXN-OTHER',
  });
  assert.strictEqual(otherContext.eddComplete, false, 'a different transaction of the same merchant must not inherit the first transaction\'s completed checklist');
  assert.strictEqual(otherContext.eddChecklist, null);
}

// Same isolation guarantee, but for the CDD checklist - required on every transaction
// regardless of risk level, so it must never leak between transactions of the same merchant
// either.
async function testCddChecklistIsIsolatedPerTransaction() {
  const completeChecklist = { business_registration_verified: 1, screening_verified: 1 };
  const database = fakeDatabase({
    merchant: { risk_tier: 'Standard' },
    cddChecklistsByTransaction: { 'TXN-CDD-COMPLETE': completeChecklist },
  });

  const completedContext = await loadMerchantCddContext(database, 'M004', { transactionId: 'TXN-CDD-COMPLETE' });
  assert.strictEqual(completedContext.cddComplete, true);

  const otherContext = await loadMerchantCddContext(database, 'M004', { transactionId: 'TXN-CDD-OTHER' });
  assert.strictEqual(otherContext.cddComplete, false, 'a different transaction of the same merchant must not inherit the first transaction\'s completed CDD checklist');
  assert.strictEqual(otherContext.cddChecklist, null);
}

async function main() {
  suite('Merchant CDD Context');
  await runTest('returns safe defaults when no merchant id is given', testReturnsDefaultsWhenNoMerchantId);
  await runTest('parses expected activity and flags an overdue review', testParsesExpectedActivityAndFlagsOverdueReview);
  await runTest('EDD completion requires all four items including senior sign-off', testComputeEddCompleteRequiresAllFourIncludingSignoff);
  await runTest('CDD completion requires both business registration and screening steps', testComputeCddCompleteRequiresBothSteps);
  await runTest('flags a past next-review-date as overdue', testIsReviewOverdue);
  await runTest('normalizes comma-separated expected countries', testParseExpectedCountries);
  await runTest('requires EDD for High and Critical transaction cases', testHighAndCriticalTransactionsRequireEdd);
  await runTest('requires EDD for a High transaction from a Standard merchant', testStandardMerchantHighTransactionRequiresEdd);
  await runTest('keeps the EDD checklist isolated per transaction for the same merchant', testEddChecklistIsIsolatedPerTransaction);
  await runTest('keeps the CDD checklist isolated per transaction for the same merchant', testCddChecklistIsIsolatedPerTransaction);
  finish();
}

main();
