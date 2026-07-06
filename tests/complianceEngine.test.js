const assert = require('assert');
const {
  calculateProfileRiskScore,
  evaluateTransaction,
  riskBands,
  riskLevelToPoints,
  companyRuleSets,
  serializeCompanyRuleSets,
} = require('../src/complianceEngine');
const { buildAnalytics } = require('../src/analyticsEngine');
const { buildCustomerRiskProfiles } = require('../src/customerRiskEngine');
const { screenPayment } = require('../src/screeningEngine');

const highRiskTransaction = {
  amount: 50000,
  country: 'Singapore',
  counterpartyCountry: 'Iran',
  merchantCategory: 'High-Value Retail',
  cardSpend24h: 52000,
  kycStatus: 'Pending Review',
  direction: 'Sale',
};

const lowRiskTransaction = {
  amount: 120,
  country: 'Singapore',
  merchantCategory: 'Retail Goods',
  cardSpend24h: 120,
  kycStatus: 'Verified',
  direction: 'Sale',
};

const highRiskResult = evaluateTransaction(highRiskTransaction);
const lowRiskResult = evaluateTransaction(lowRiskTransaction);
const localTimestampAtHour = (hour) => new Date(2026, 0, 1, hour, 0, 0).toISOString();
const afternoonOperatingHoursResult = evaluateTransaction({ ...lowRiskTransaction, createdAt: localTimestampAtHour(14) });
const overnightOperatingHoursResult = evaluateTransaction({ ...lowRiskTransaction, createdAt: localTimestampAtHour(2) });
const industryRiskResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 12 });
const mediumActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 30 });
const highActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 50 });
const criticalActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 70 });
const profileRiskResult = evaluateTransaction({
  ...lowRiskTransaction,
  customerRiskLevel: 'HIGH',
  merchantRiskLevel: 'MEDIUM',
});
const highProfileRiskResult = evaluateTransaction({
  ...lowRiskTransaction,
  customerRiskLevel: 'HIGH',
  merchantRiskLevel: 'HIGH',
});

assert.strictEqual(highRiskResult.transactionDetectionScore, 115);
assert.strictEqual(highRiskResult.finalRiskScore, 115);
assert.strictEqual(highRiskResult.riskScore, 115);
assert.strictEqual(riskBands(highRiskResult.riskScore), 'Critical');
assert.strictEqual(highRiskResult.matchedRules.length, 4);

assert.strictEqual(lowRiskResult.riskScore, 0);
assert.strictEqual(lowRiskResult.mccRiskScore, 0);
assert.strictEqual(lowRiskResult.profileRiskScore, 0);
assert.strictEqual(lowRiskResult.transactionDetectionScore, 0);
assert.strictEqual(lowRiskResult.finalRiskScore, 0);
assert.strictEqual(riskBands(lowRiskResult.riskScore), 'Low');
assert.strictEqual(lowRiskResult.matchedRules.length, 0);
assert.strictEqual(lowRiskResult.recommendedAction, 'Allow');

assert.strictEqual(afternoonOperatingHoursResult.transactionHour, 14);
assert.strictEqual(afternoonOperatingHoursResult.operatingHoursTriggered, false);
assert.strictEqual(afternoonOperatingHoursResult.transactionDetectionScore, 0);
assert.ok(!afternoonOperatingHoursResult.triggeredRules.some((rule) => rule.id === 'TIME-001'));
assert.strictEqual(overnightOperatingHoursResult.transactionHour, 2);
assert.strictEqual(overnightOperatingHoursResult.operatingHoursTriggered, true);
assert.strictEqual(overnightOperatingHoursResult.transactionDetectionScore, 10);
assert.strictEqual(overnightOperatingHoursResult.finalRiskScore, 10);
assert.ok(overnightOperatingHoursResult.triggeredRules.some((rule) => rule.id === 'TIME-001'));

assert.strictEqual(mediumActionResult.riskLevel, 'Medium');
assert.strictEqual(mediumActionResult.recommendedAction, 'Monitor');
assert.strictEqual(highActionResult.riskLevel, 'High');
assert.strictEqual(highActionResult.recommendedAction, 'Request OTP');
assert.strictEqual(criticalActionResult.riskLevel, 'Critical');
assert.strictEqual(criticalActionResult.recommendedAction, 'Manual Review or Hold Settlement');

assert.strictEqual(industryRiskResult.riskScore, 12);
assert.strictEqual(industryRiskResult.mccRiskScore, 12);
assert.strictEqual(industryRiskResult.matchedRules.length, 0);
assert.strictEqual(companyRuleSets.companyA.mccCode, '5651');
assert.strictEqual(serializeCompanyRuleSets()[0].industryRiskScore, 8);

assert.strictEqual(riskLevelToPoints('LOW'), 0);
assert.strictEqual(riskLevelToPoints('MEDIUM'), 15);
assert.strictEqual(riskLevelToPoints('HIGH'), 30);
assert.strictEqual(calculateProfileRiskScore({ customerRiskLevel: 'HIGH', merchantRiskLevel: 'MEDIUM' }), 45);
assert.strictEqual(profileRiskResult.profileRiskScore, 45);
assert.strictEqual(profileRiskResult.riskScore, 45);
assert.strictEqual(profileRiskResult.riskLevel, 'Medium');
assert.strictEqual(highProfileRiskResult.profileRiskScore, 60);
assert.strictEqual(highProfileRiskResult.riskLevel, 'High');
assert.strictEqual(highProfileRiskResult.recommendedAction, 'Request OTP');
assert.ok(highProfileRiskResult.matchedRules.some((rule) => rule.id === 'PROFILE-CUSTOMER-HIGH'));
assert.ok(highProfileRiskResult.matchedRules.some((rule) => rule.id === 'PROFILE-MERCHANT-HIGH'));

const analytics = buildAnalytics(
  [
    {
      status: 'Flagged',
      riskBand: 'High',
      riskScore: 55,
      amount: 1500,
      country: 'Singapore',
      counterpartyCountry: 'Iran',
      companyName: 'Merchant Profile 5651',
      customerName: 'Ava Lim',
      matchedRules: [{ name: 'Contextual jurisdiction escalation', weight: 20 }],
    },
    {
      status: 'Cleared',
      riskBand: 'Low',
      riskScore: 0,
      amount: 120,
      country: 'Singapore',
      companyName: 'Merchant Profile 5651',
      customerName: 'Noah Tan',
      matchedRules: [],
    },
  ],
  [{ status: 'Escalated' }],
  [{ dueAt: new Date(Date.now() - 60 * 1000).toISOString() }],
);

assert.strictEqual(analytics.summary.flagRate, 50);
assert.strictEqual(analytics.summary.highRiskRate, 50);
assert.strictEqual(analytics.summary.escalatedAlerts, 1);
assert.strictEqual(analytics.summary.overdueCases, 1);
assert.strictEqual(analytics.drivers[0].label, 'Contextual jurisdiction escalation');

const screening = screenPayment({
  customerName: 'Ava Lim',
  counterpartyName: 'Orion Trade Holdings',
  counterpartyCountry: 'Iran',
  paymentReference: 'Card payment linked to Orion Trade Holdings',
});

assert.strictEqual(screening.status, 'Potential Match');
assert.strictEqual(screening.matches[0].type, 'Sanctions');

const customerProfiles = buildCustomerRiskProfiles(
  [
    {
      customerId: 'CUS-1003',
      customerName: 'Maya Wong',
      segment: 'Private Client',
      kycStatus: 'Enhanced Due Diligence',
      customerRiskLevel: 'HIGH',
      merchantRiskLevel: 'MEDIUM',
      country: 'Singapore',
      companyId: 'companyA',
      companyName: 'Merchant Profile 5651',
      status: 'Flagged',
      riskScore: 70,
      amount: 3000,
      screeningMatches: [],
    },
  ],
  [{ customerId: 'CUS-1003', status: 'New' }],
);

assert.strictEqual(customerProfiles[0].screeningStatus, 'Potential Match');
assert.ok(customerProfiles[0].riskScore >= 50);

console.log('Compliance engine tests passed');
