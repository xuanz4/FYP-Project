const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { ensureMerchant, ingestTransaction } = require('../src/transactionIngestion');

function fakeDatabase({ history = [], rules = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ type: 'query', sql, params });
      if (/FROM merchant_risk_profiles/.test(sql)) return [[]];
      if (/FROM merchant_cdd_profiles/.test(sql)) return [[]];
      if (/FROM merchant_cdd_checklist/.test(sql)) return [[]];
      if (/FROM merchant_edd_checklist/.test(sql)) return [[]];
      if (/SELECT unique_transaction_reference/.test(sql)) return [[]];
      if (/SELECT risk_tier FROM merchants/.test(sql)) return [[{ risk_tier: 'Standard' }]];
      if (/SELECT merchant_id, merchant_name, merchant_mid FROM merchants/.test(sql)) {
        return [[{ merchant_id: params[0], merchant_name: 'Test Merchant', merchant_mid: null }]];
      }
      if (/FROM transactions/.test(sql)) return [history];
      if (/FROM compliance_rules/.test(sql)) return [rules];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      calls.push({ type: 'execute', sql, params });
      return [{ affectedRows: 1 }];
    },
  };
}

async function testEnsureMerchantUpsertsPartnerMerchant() {
  const database = fakeDatabase();
  await ensureMerchant(database, {
    merchantId: 'M001',
    merchantName: 'Demo Merchant',
    merchantMid: 'MID001',
    merchantCountry: 'SG',
    authorisedContactName: 'Ops Lead',
    authorisedContactEmail: 'ops@example.test',
    mccCode: '5812',
    industry: 'Food',
    mccRiskScore: 8,
    riskTier: 'High',
  });

  const executeCall = database.calls.find((call) => call.type === 'execute');
  assert.match(executeCall.sql, /INSERT INTO merchants/);
  assert.deepStrictEqual(executeCall.params, [
    'M001',
    'Demo Merchant',
    'MID001',
    'SG',
    'Ops Lead',
    'ops@example.test',
    '5812',
    'Food',
    8,
    'High',
  ]);
}

async function testEnsureMerchantUsesDefaultsForMissingOptionalFields() {
  const database = fakeDatabase();
  await ensureMerchant(database, {
    merchantId: 'M002',
    merchantName: 'Default Merchant',
  });

  const executeCall = database.calls.find((call) => call.type === 'execute');
  assert.deepStrictEqual(executeCall.params, [
    'M002',
    'Default Merchant',
    null,
    null,
    null,
    null,
    '0000',
    'Unclassified',
    0,
    'Standard',
  ]);
}

async function testIngestTransactionPersistsEvaluationAndBroadcasts() {
  const database = fakeDatabase({
    rules: [
      {
        rule_id: 'R-AMOUNT',
        rule_name: 'Amount Spike',
        risk_level: 'High',
        reason: 'Large transaction',
        weight: 55,
        amount_threshold: 1000,
        count_threshold: null,
        rule_type: 'amount_spike',
      },
    ],
  });
  const events = [];

  const evaluation = await ingestTransaction(
    database,
    {
      id: 'UNIT-REFERENCE-A',
      merchantId: 'M001',
      storeId: 'S001',
      amount: 1500,
      method: 'card',
      scheme: 'visa',
      issuer: 'SG',
      issuerBank: 'Example Bank',
      cardBin: '424242',
      cardLast4: '4242',
      cardRef: 'CARD-TOKEN-001',
      cvvValidationResult: 'Passed',
      expiryValidationResult: 'Passed',
      transactionCode: 'AUTH-001',
      transactionType: 'sale',
      entryMode: 'chip',
      status: 'captured',
      statusLabel: 'Captured',
      statusTone: 'success',
      net: 1485,
      fee: 15,
      txnTime: new Date('2026-07-21T10:00:00'),
      note: 'Live feed',
    },
    { merchantCountry: 'SG', riskTier: 'Standard' },
    { broadcast: (event, data) => events.push({ event, data }) },
  );

  assert.strictEqual(evaluation.riskScore, 55);
  assert.strictEqual(evaluation.riskLevel, 'High');
  assert.strictEqual(evaluation.status, 'Flagged');

  const transactionInsert = database.calls.find((call) => (
    call.type === 'execute' && /INSERT INTO transactions/.test(call.sql)
  ));
  assert.ok(transactionInsert);
  assert.strictEqual(transactionInsert.params[0], 'UNIT-REFERENCE-A');
  assert.match(transactionInsert.params[1], /^TXN-\d{4}-\d{6}$/);
  assert.strictEqual(transactionInsert.params[8], 'Example Bank');
  assert.strictEqual(transactionInsert.params[9], '424242');
  assert.strictEqual(transactionInsert.params[10], '4242');
  assert.strictEqual(transactionInsert.params[11], 'Passed');
  assert.strictEqual(transactionInsert.params[12], 'Passed');
  assert.strictEqual(transactionInsert.params[13], 'AUTH-001');
  assert.strictEqual(transactionInsert.params[23], 55);
  assert.strictEqual(transactionInsert.params[24], 'High');
  assert.strictEqual(transactionInsert.params[25], 0);
  assert.strictEqual(transactionInsert.params[26], 0);
  assert.strictEqual(transactionInsert.params[27], 55);
  assert.strictEqual(transactionInsert.params[28], 'Flagged');
  assert.strictEqual(transactionInsert.params[30], 'CARD-TOKEN-001');

  const ruleInsert = database.calls.find((call) => (
    call.type === 'execute' && /INSERT INTO transaction_matched_rules/.test(call.sql)
  ));
  assert.deepStrictEqual(ruleInsert.params, ['UNIT-REFERENCE-A', 'R-AMOUNT']);

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'transaction');
  assert.match(events[0].data.uniqueTransactionReference, /^TXN-\d{4}-\d{6}$/);
  assert.deepStrictEqual({ ...events[0].data, uniqueTransactionReference: undefined }, {
    transactionId: 'UNIT-REFERENCE-A',
    uniqueTransactionReference: undefined,
    merchantId: 'M001',
    amount: 1500,
    riskLevel: 'High',
    status: 'Flagged',
  });
}

async function testIngestTransactionClearsLowRiskTransactionWithoutBroadcast() {
  const database = fakeDatabase();
  const evaluation = await ingestTransaction(
    database,
    {
      id: 'TXN-LOW-001',
      merchantId: 'M001',
      storeId: 'S001',
      amount: 25,
      txnTime: '2026-07-21T10:00:00',
    },
    { merchantCountry: 'SG', riskTier: 'Standard', mccRiskScore: 0 },
  );

  assert.strictEqual(evaluation.riskScore, 0);
  assert.strictEqual(evaluation.riskLevel, 'Low');
  assert.strictEqual(evaluation.status, 'Cleared');
  assert.strictEqual(evaluation.matchedRules.length, 0);

  const ruleInsert = database.calls.find((call) => (
    call.type === 'execute' && /INSERT INTO transaction_matched_rules/.test(call.sql)
  ));
  assert.strictEqual(ruleInsert, undefined);
}

async function testIngestTransactionNormalizesStringAmountsAndDates() {
  const database = fakeDatabase({
    rules: [{
      rule_id: 'R-TICKET',
      rule_name: 'Declared Average Ticket',
      risk_level: 'Medium',
      reason: 'Above declared ticket',
      weight: 30,
      amount_threshold: 100,
      count_threshold: null,
      rule_type: 'declared_avg_ticket',
    }],
  });

  const evaluation = await ingestTransaction(
    database,
    {
      id: 'TXN-STRING-001',
      merchantId: 'M001',
      amount: '150',
      issuer: 'SG',
      txnTime: '2026-07-21T10:00:00',
    },
    { merchantCountry: 'SG', riskTier: 'Standard', mccRiskScore: 5 },
  );

  assert.strictEqual(evaluation.riskScore, 35);
  assert.strictEqual(evaluation.riskLevel, 'Medium');
  const transactionInsert = database.calls.find((call) => (
    call.type === 'execute' && /INSERT INTO transactions/.test(call.sql)
  ));
  assert.ok(transactionInsert.params[21] instanceof Date);
}

async function main() {
  suite('Transaction Ingestion');
  await runTest('upserts partner merchant details', testEnsureMerchantUpsertsPartnerMerchant);
  await runTest('uses safe defaults when merchant optional fields are missing', testEnsureMerchantUsesDefaultsForMissingOptionalFields);
  await runTest('persists evaluated transaction, matched rules, and broadcast event', testIngestTransactionPersistsEvaluationAndBroadcasts);
  await runTest('clears low-risk transaction without matched-rule inserts', testIngestTransactionClearsLowRiskTransactionWithoutBroadcast);
  await runTest('normalizes string transaction amounts and dates', testIngestTransactionNormalizesStringAmountsAndDates);
  finish();
}

main();
