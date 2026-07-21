const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { ensureMerchant, ingestTransaction } = require('../src/transactionIngestion');

function fakeDatabase({ history = [], rules = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ type: 'query', sql, params });
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
      id: 'TXN-001',
      merchantId: 'M001',
      storeId: 'S001',
      amount: 1500,
      method: 'card',
      scheme: 'visa',
      issuer: 'SG',
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
  assert.strictEqual(transactionInsert.params[0], 'TXN-001');
  assert.strictEqual(transactionInsert.params[16], 55);
  assert.strictEqual(transactionInsert.params[17], 'High');
  assert.strictEqual(transactionInsert.params[18], 'Flagged');

  const ruleInsert = database.calls.find((call) => (
    call.type === 'execute' && /INSERT INTO transaction_matched_rules/.test(call.sql)
  ));
  assert.deepStrictEqual(ruleInsert.params, ['TXN-001', 'R-AMOUNT']);

  assert.deepStrictEqual(events, [{
    event: 'transaction',
    data: {
      transactionId: 'TXN-001',
      merchantId: 'M001',
      amount: 1500,
      riskLevel: 'High',
      status: 'Flagged',
    },
  }]);
}

async function main() {
  suite('Transaction Ingestion');
  await runTest('upserts partner merchant details', testEnsureMerchantUpsertsPartnerMerchant);
  await runTest('persists evaluated transaction, matched rules, and broadcast event', testIngestTransactionPersistsEvaluationAndBroadcasts);
  finish();
}

main();
