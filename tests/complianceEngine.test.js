const assert = require('assert');
const { evaluateTransaction, riskBands } = require('../src/complianceEngine');

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

console.log('Compliance engine tests passed');
