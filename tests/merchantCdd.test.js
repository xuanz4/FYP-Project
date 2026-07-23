const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  loadMerchantCddContext,
  computeEddComplete,
  isReviewOverdue,
  parseExpectedCountries,
  requiresEdd,
} = require('../src/lib/merchantCdd');

function fakeDatabase({ merchant = null, profile = null, checklist = null } = {}) {
  return {
    async query(sql) {
      if (/SELECT risk_tier FROM merchants/.test(sql)) return [merchant ? [merchant] : []];
      if (/FROM merchant_cdd_profiles/.test(sql)) return [profile ? [profile] : []];
      if (/FROM merchant_edd_checklist/.test(sql)) return [checklist ? [checklist] : []];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

async function testReturnsDefaultsWhenNoMerchantId() {
  const context = await loadMerchantCddContext(fakeDatabase(), null);
  assert.strictEqual(context.kycStatus, 'Not Started');
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
    checklist: {
      source_of_funds_verified: 1,
      site_visit_completed: 1,
      enhanced_verification_completed: 0,
      senior_signoff_completed: 0,
    },
  });

  const context = await loadMerchantCddContext(database, 'M001');
  assert.strictEqual(context.kycStatus, 'Verified');
  assert.strictEqual(context.reviewOverdue, true);
  assert.strictEqual(context.expectedAvgTicket, 150.5);
  assert.strictEqual(context.expectedMonthlyVolume, 10000);
  assert.deepStrictEqual(context.expectedCountries, ['SG', 'MY', 'ID']);
  assert.deepStrictEqual(context.expectedOperatingHours, { openHour: 8, closeHour: 20 });
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

async function main() {
  suite('Merchant CDD Context');
  await runTest('returns safe defaults when no merchant id is given', testReturnsDefaultsWhenNoMerchantId);
  await runTest('parses expected activity and flags an overdue review', testParsesExpectedActivityAndFlagsOverdueReview);
  await runTest('EDD completion requires all four items including senior sign-off', testComputeEddCompleteRequiresAllFourIncludingSignoff);
  await runTest('flags a past next-review-date as overdue', testIsReviewOverdue);
  await runTest('normalizes comma-separated expected countries', testParseExpectedCountries);
  await runTest('requires EDD for High and Critical transaction cases', testHighAndCriticalTransactionsRequireEdd);
  await runTest('requires EDD for a High transaction from a Standard merchant', testStandardMerchantHighTransactionRequiresEdd);
  finish();
}

main();
