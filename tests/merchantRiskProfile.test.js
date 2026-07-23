const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  computeProfileRiskScore,
  buildHistoricalProfileRiskUpdates,
  generateUniqueTransactionReference,
  upsertMerchantRiskProfile,
  MIN_TRANSACTIONS_FOR_SCORING,
} = require('../src/lib/merchantRiskProfile');

function testProfileRiskScoreBands() {
  assert.strictEqual(MIN_TRANSACTIONS_FOR_SCORING, 5);
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 10, flaggedTransactionRate: 0, escalationCount: 0, confirmedSuspiciousCaseCount: 0, ruleTriggerCount: 0,
  }), 0);
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 10, flaggedTransactionRate: 1, escalationCount: 0, confirmedSuspiciousCaseCount: 0, ruleTriggerCount: 0,
  }), 40);
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 10, flaggedTransactionRate: 0, escalationCount: 5, confirmedSuspiciousCaseCount: 0, ruleTriggerCount: 0,
  }), 20);
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 10, flaggedTransactionRate: 0, escalationCount: 0, confirmedSuspiciousCaseCount: 5, ruleTriggerCount: 0,
  }), 30);
  // Everything maxed out should cap at 100, never exceed it.
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 10, flaggedTransactionRate: 1, escalationCount: 10, confirmedSuspiciousCaseCount: 10, ruleTriggerCount: 100,
  }), 100);
}

function testProfileRiskScoreHandlesNoTransactions() {
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 0, flaggedTransactionRate: 0, escalationCount: 0, confirmedSuspiciousCaseCount: 0, ruleTriggerCount: 5,
  }), 0);
}

function testHistoricalProfileRiskUsesEarlierHistoryOnly() {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    transaction_id: `TX-${index + 1}`,
    merchant_id: 'M001',
    mcc_risk_contribution: 5,
    transaction_detection_contribution: index < 5 ? 30 : 0,
    rule_trigger_count: index < 5 ? 1 : 0,
    escalated: 0,
    str_filed: 0,
  }));
  const updates = buildHistoricalProfileRiskUpdates(rows);

  assert.deepStrictEqual(
    updates.slice(0, MIN_TRANSACTIONS_FOR_SCORING).map((row) => row.profileRiskContribution),
    [0, 0, 0, 0, 0],
  );
  assert.ok(updates[5].profileRiskContribution > 0);
  assert.ok(updates.every((row) => row.riskScore <= 100));
}

function testProfileRiskScoreAddsMixedSignals() {
  assert.strictEqual(computeProfileRiskScore({
    transactionCount: 20, flaggedTransactionRate: 0.5, escalationCount: 1, confirmedSuspiciousCaseCount: 1, ruleTriggerCount: 10,
  }), 50);
}

function fakeReferenceDatabase(existingReferences = []) {
  return {
    async query(sql, params) {
      const like = String(params[0] || '');
      const matches = existingReferences.filter((ref) => ref.startsWith(like.replace('%', '')));
      matches.sort().reverse();
      return [matches.map((ref) => ({ unique_transaction_reference: ref }))];
    },
  };
}

async function testUniqueTransactionReferenceGeneration() {
  const emptyDb = fakeReferenceDatabase([]);
  const first = await generateUniqueTransactionReference(emptyDb, new Date('2026-07-21T10:00:00'));
  assert.strictEqual(first, 'TXN-2026-000001');

  const populatedDb = fakeReferenceDatabase(['TXN-2026-000001', 'TXN-2026-000047', 'TXN-2025-000900']);
  const next = await generateUniqueTransactionReference(populatedDb, new Date('2026-07-21T10:00:00'));
  assert.strictEqual(next, 'TXN-2026-000048');

  // Sequence is year-scoped: a prior year's higher sequence must not leak into the new year.
  const newYearDb = fakeReferenceDatabase(['TXN-2025-000900']);
  const newYearFirst = await generateUniqueTransactionReference(newYearDb, new Date('2026-01-01T00:00:00'));
  assert.strictEqual(newYearFirst, 'TXN-2026-000001');
}

async function testUniqueTransactionReferenceIgnoresMalformedSequence() {
  const db = fakeReferenceDatabase(['TXN-2026-ABCDEF']);
  const next = await generateUniqueTransactionReference(db, new Date('2026-07-21T10:00:00'));
  assert.strictEqual(next, 'TXN-2026-000001');
}

function fakeProfileDatabase({ merchantMid = 'MID001', transactionCount = 5 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ type: 'query', sql, params });
      if (/FROM merchants/.test(sql)) {
        return [[merchantMid ? {
          merchant_id: params[0],
          merchant_name: 'Profile Merchant',
          merchant_mid: merchantMid,
        } : {
          merchant_id: params[0],
          merchant_name: 'Profile Merchant',
          merchant_mid: null,
        }]];
      }
      if (/FROM transactions\s+WHERE/.test(sql)) {
        return [[{
          transaction_count: transactionCount,
          flagged_transaction_count: transactionCount,
          declined_transaction_count: 1,
          total_transaction_amount: 1000.123,
          average_transaction_amount: 200.456,
          maximum_transaction_amount: 300.789,
          first_seen_at: new Date('2026-07-01T00:00:00Z'),
          last_seen_at: new Date('2026-07-05T00:00:00Z'),
        }]];
      }
      if (/FROM transaction_matched_rules/.test(sql)) return [[{ rule_trigger_count: 5 }]];
      if (/FROM cases/.test(sql)) return [[{ escalation_count: 1 }]];
      if (/FROM str_reports/.test(sql)) return [[{ confirmed_suspicious_case_count: 1 }]];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      calls.push({ type: 'execute', sql, params });
      return [{ affectedRows: 1 }];
    },
  };
}

async function testUpsertMerchantRiskProfileSkipsMissingMid() {
  const db = fakeProfileDatabase({ merchantMid: null });
  await upsertMerchantRiskProfile(db, 'M001');
  assert.strictEqual(db.calls.some((call) => call.type === 'execute'), false);
}

async function testUpsertMerchantRiskProfileWritesInsufficientHistory() {
  const db = fakeProfileDatabase({ transactionCount: 4 });
  await upsertMerchantRiskProfile(db, 'M001');
  const executeCall = db.calls.find((call) => call.type === 'execute');
  assert.ok(executeCall);
  assert.strictEqual(executeCall.params[3], 4);
  assert.strictEqual(executeCall.params[13], 0);
  assert.strictEqual(executeCall.params[14], 'Insufficient History');
  assert.match(executeCall.params[15], /Fewer than 5 transactions/);
}

async function main() {
  suite('Merchant Risk Profile');
  await runTest('computes profile risk score bands capped at 100', testProfileRiskScoreBands);
  await runTest('computes zero profile score when there are no transactions', testProfileRiskScoreHandlesNoTransactions);
  await runTest('rebuilds profile contributions from earlier merchant history only', testHistoricalProfileRiskUsesEarlierHistoryOnly);
  await runTest('adds mixed merchant profile risk signals', testProfileRiskScoreAddsMixedSignals);
  await runTest('generates sequential, year-scoped unique transaction references', testUniqueTransactionReferenceGeneration);
  await runTest('ignores malformed transaction reference sequences', testUniqueTransactionReferenceIgnoresMalformedSequence);
  await runTest('skips merchant profile upsert when merchant MID is missing', testUpsertMerchantRiskProfileSkipsMissingMid);
  await runTest('writes insufficient-history merchant profile safely', testUpsertMerchantRiskProfileWritesInsufficientHistory);
  finish();
}

main();
