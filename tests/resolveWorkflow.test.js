const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { parseRequiredWholeNumber, buildReconciliationResult } = require('../src/lib/resolveWorkflow');

function testParseRequiredWholeNumber() {
  assert.strictEqual(parseRequiredWholeNumber(50), 50);
  assert.strictEqual(parseRequiredWholeNumber('0'), 0);
  assert.strictEqual(parseRequiredWholeNumber('100'), 100);
  assert.strictEqual(parseRequiredWholeNumber(null), null);
  assert.strictEqual(parseRequiredWholeNumber(undefined), null);
  assert.strictEqual(parseRequiredWholeNumber(''), null);
  assert.strictEqual(parseRequiredWholeNumber('abc'), null);
  assert.strictEqual(parseRequiredWholeNumber(-1), null);
  assert.strictEqual(parseRequiredWholeNumber(101), null);
  assert.strictEqual(parseRequiredWholeNumber(12.5), null);
}

function testReconciliationMatch() {
  const result = buildReconciliationResult({
    actualMccContribution: 25, actualProfileContribution: 10, actualDetectionContribution: 15, actualScore: 50,
    manualMccContribution: 25, manualProfileContribution: 10, manualDetectionContribution: 15, manualFinalScore: 50,
  });
  assert.strictEqual(result.discrepancyFlag, false);
  assert.match(result.discrepancyNotes, /matched the automated calculation/);
  assert.deepStrictEqual(result.mismatches, []);
}

function testReconciliationDiscrepancy() {
  const result = buildReconciliationResult({
    actualMccContribution: 25, actualProfileContribution: 10, actualDetectionContribution: 15, actualScore: 50,
    manualMccContribution: 20, manualProfileContribution: 10, manualDetectionContribution: 15, manualFinalScore: 45,
  });
  assert.strictEqual(result.discrepancyFlag, true);
  assert.match(result.discrepancyNotes, /MCC: expected 25, entered 20/);
  assert.match(result.discrepancyNotes, /Final: expected 50, entered 45/);
  assert.strictEqual(result.mismatches.length, 2);
}

function testReconciliationTreatsNullActualsAsZero() {
  const result = buildReconciliationResult({
    actualMccContribution: null, actualProfileContribution: null, actualDetectionContribution: null, actualScore: null,
    manualMccContribution: 0, manualProfileContribution: 0, manualDetectionContribution: 0, manualFinalScore: 0,
  });
  assert.strictEqual(result.discrepancyFlag, false);
}

async function main() {
  suite('Resolve Workflow');
  await runTest('parses required whole numbers for manual reconciliation fields', testParseRequiredWholeNumber);
  await runTest('reports no discrepancy when manual entry matches the automated calculation', testReconciliationMatch);
  await runTest('reports a discrepancy with details when manual entry differs', testReconciliationDiscrepancy);
  await runTest('treats an unset actual contribution as zero, not a forced mismatch', testReconciliationTreatsNullActualsAsZero);
  finish();
}

main();
