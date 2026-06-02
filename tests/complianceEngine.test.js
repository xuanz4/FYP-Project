const assert = require('assert');
const { evaluateTransaction, riskBands } = require('../src/complianceEngine');
const { buildAnalytics } = require('../src/analyticsEngine');
const { buildCustomerRiskProfiles } = require('../src/customerRiskEngine');
const { screenPayment } = require('../src/screeningEngine');

const highRiskTransaction = {
  amount: 50000,
  country: 'Iran',
  merchantCategory: 'Crypto Exchange',
  kycStatus: 'Pending Review',
  direction: 'Outbound',
};

const lowRiskTransaction = {
  amount: 120,
  country: 'Singapore',
  merchantCategory: 'Grocery',
  kycStatus: 'Verified',
  direction: 'Inbound',
};

const highRiskResult = evaluateTransaction(highRiskTransaction);
const lowRiskResult = evaluateTransaction(lowRiskTransaction);

assert.strictEqual(highRiskResult.riskScore, 100);
assert.strictEqual(riskBands(highRiskResult.riskScore), 'Critical');
assert.strictEqual(highRiskResult.matchedRules.length, 5);

assert.strictEqual(lowRiskResult.riskScore, 0);
assert.strictEqual(riskBands(lowRiskResult.riskScore), 'Low');
assert.strictEqual(lowRiskResult.matchedRules.length, 0);

const analytics = buildAnalytics(
  [
    {
      status: 'Flagged',
      riskBand: 'High',
      riskScore: 55,
      amount: 1500,
      country: 'Iran',
      companyName: 'Company A',
      customerName: 'Ava Lim',
      matchedRules: [{ name: 'High-risk jurisdiction', weight: 40 }],
    },
    {
      status: 'Cleared',
      riskBand: 'Low',
      riskScore: 0,
      amount: 120,
      country: 'Singapore',
      companyName: 'Company A',
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
assert.strictEqual(analytics.drivers[0].label, 'High-risk jurisdiction');

const screening = screenPayment({
  customerName: 'Ava Lim',
  counterpartyName: 'Orion Trade Holdings',
  counterpartyCountry: 'Iran',
  paymentReference: 'Invoice payment to Orion Trade Holdings',
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
      country: 'Singapore',
      companyId: 'companyA',
      companyName: 'Company A',
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
