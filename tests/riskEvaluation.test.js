const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { evaluateTransaction } = require('../src/riskEngine');

function fakeDatabase({ history, rules, profileRows = [], calls }) {
  return {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM merchant_risk_profiles/.test(sql)) return [profileRows];
      if (/FROM transactions/.test(sql)) return [history];
      if (/FROM compliance_rules/.test(sql)) return [rules];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

async function testRuleMatchesAndSignals() {
  const txnTime = new Date('2026-07-21T22:30:00');
  const calls = [];
  const result = await evaluateTransaction({
    txn: {
      merchantId: 'M001',
      merchantCountry: 'SG',
      merchantRiskTier: 'High',
      storeId: 'S3',
      amount: 9500,
      issuerCountry: 'MY',
      txnTime,
    },
    database: fakeDatabase({
      calls,
      history: [
        { store_id: 'S1', amount: 9200, issuer_country: 'MY', txn_time: '2026-07-21T22:15:00' },
        { store_id: 'S2', amount: 9300, issuer_country: 'ID', txn_time: '2026-07-21T22:20:00' },
        { store_id: 'S3', amount: 10, issuer_country: 'SG', txn_time: '2026-07-21T22:25:00' },
      ],
      rules: [
        { rule_id: 'R1', rule_name: 'Amount Spike', risk_level: 'High', reason: 'Large payment', weight: 30, amount_threshold: 9000, count_threshold: null, rule_type: 'amount_spike' },
        { rule_id: 'R2', rule_name: 'Cross Store Velocity', risk_level: 'Medium', reason: 'Many stores', weight: 20, amount_threshold: null, count_threshold: 3, rule_type: 'cross_store_velocity' },
        { rule_id: 'R3', rule_name: 'Near Threshold', risk_level: 'High', reason: 'Structuring band', weight: 25, amount_threshold: 10000, count_threshold: 3, rule_type: 'near_threshold' },
        { rule_id: 'R4', rule_name: 'Foreign Issuer Concentration', risk_level: 'Medium', reason: 'Foreign cards', weight: 15, amount_threshold: null, count_threshold: 3, rule_type: 'foreign_issuer_concentration' },
        { rule_id: 'R5', rule_name: 'High Risk Merchant', risk_level: 'Medium', reason: 'EDD required', weight: 15, amount_threshold: null, count_threshold: null, rule_type: 'edd_high_risk' },
      ],
    }),
  });

  assert.strictEqual(result.riskScore, 100);
  assert.strictEqual(result.riskLevel, 'Critical');
  assert.strictEqual(result.status, 'Flagged');
  assert.deepStrictEqual(result.matchedRules.map((rule) => rule.id), ['R1', 'R2', 'R3', 'R4', 'R5']);
  assert.strictEqual(result.signals.crossStoreVelocity, 3);
  assert.strictEqual(result.signals.foreignIssuerCount, 3);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0].params, ['M001', new Date('2026-07-20T22:30:00'), txnTime]);
  assert.deepStrictEqual(calls[1].params, ['M001']);
}

async function testLowRiskMatchRemainsCleared() {
  const result = await evaluateTransaction({
    txn: {
      merchantId: 'M002',
      merchantCountry: 'SG',
      merchantRiskTier: 'Standard',
      storeId: 'S1',
      amount: 25,
      issuerCountry: 'US',
      txnTime: new Date('2026-07-21T12:00:00'),
    },
    database: fakeDatabase({
      calls: [],
      history: [],
      rules: [
        { rule_id: 'R6', rule_name: 'Foreign Issuer', risk_level: 'Low', reason: 'Foreign-issued card', weight: 10, amount_threshold: null, count_threshold: null, rule_type: 'foreign_issuer' },
      ],
    }),
  });

  assert.strictEqual(result.riskScore, 10);
  assert.strictEqual(result.riskLevel, 'Low');
  assert.strictEqual(result.status, 'Cleared');
  assert.deepStrictEqual(result.matchedRules.map((rule) => rule.id), ['R6']);
}

async function testStoredMerchantProfileContributesToRiskScore() {
  const result = await evaluateTransaction({
    txn: {
      merchantId: 'M003',
      merchantMid: 'MID003',
      merchantCountry: 'SG',
      merchantRiskTier: 'Standard',
      storeId: 'S1',
      amount: 150,
      issuerCountry: 'SG',
      txnTime: new Date('2026-07-21T12:00:00'),
      mccRiskScore: 10,
    },
    database: fakeDatabase({
      calls: [],
      history: [],
      profileRows: [{ profile_risk_score: 35, transaction_count: 8 }],
      rules: [],
    }),
  });

  assert.strictEqual(result.mccRiskContribution, 10);
  assert.strictEqual(result.profileRiskContribution, 35);
  assert.strictEqual(result.detectionContribution, 0);
  assert.strictEqual(result.riskScore, 45);
  assert.strictEqual(result.riskLevel, 'Medium');
  assert.strictEqual(result.status, 'Flagged');
}

async function main() {
  suite('Risk Evaluation');
  await runTest('matches risk rules and derives velocity/concentration signals', testRuleMatchesAndSignals);
  await runTest('keeps low-risk single rule match cleared', testLowRiskMatchRemainsCleared);
  await runTest('adds stored merchant profile contribution to risk score', testStoredMerchantProfileContributesToRiskScore);
  finish();
}

main();
