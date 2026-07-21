const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { computeProfileRiskScore, generateUniqueTransactionReference, MIN_TRANSACTIONS_FOR_SCORING } = require('../src/lib/merchantRiskProfile');

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

async function main() {
  suite('Merchant Risk Profile');
  await runTest('computes profile risk score bands capped at 100', testProfileRiskScoreBands);
  await runTest('generates sequential, year-scoped unique transaction references', testUniqueTransactionReferenceGeneration);
  finish();
}

main();
