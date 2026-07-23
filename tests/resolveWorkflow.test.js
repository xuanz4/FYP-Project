const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  parseRequiredWholeNumber,
  calculateFinalScoreFromContributions,
  reviewRequirementForScoreChange,
  buildReconciliationResult,
  cddGateRequirement,
} = require('../src/lib/resolveWorkflow');

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

function testCalculateFinalScoreFromContributions() {
  assert.strictEqual(calculateFinalScoreFromContributions(20, 15, 35), 70);
  assert.strictEqual(calculateFinalScoreFromContributions(0, 0, 0), 0);
  assert.strictEqual(calculateFinalScoreFromContributions(80, 20, 15), 100);
}

function testReviewRequirementAllowsSameBandSmallChange() {
  const result = reviewRequirementForScoreChange({
    role: 'Analyst',
    automatedScore: 55,
    manualFinalScore: 60,
    analystNotes: 'Reviewed invoice and supporting records.',
  });
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.originalLevel, 'High');
  assert.strictEqual(result.finalLevel, 'High');
}

function testReviewRequirementNeedsDetailedNotesForLargeChange() {
  const result = reviewRequirementForScoreChange({
    role: 'Senior Analyst',
    automatedScore: 35,
    manualFinalScore: 65,
    analystNotes: 'Too short',
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.status, 400);
  assert.match(result.message, /detailed justification/);
}

function testReviewRequirementBlocksAnalystLoweringRiskBand() {
  const result = reviewRequirementForScoreChange({
    role: 'Analyst',
    automatedScore: 72,
    manualFinalScore: 45,
    analystNotes: 'Reviewed all supporting documents and merchant explanation.',
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.status, 403);
  assert.match(result.message, /Senior Analyst approval/);
}

function testReviewRequirementAllowsSeniorLoweringRiskBandWithDetail() {
  const result = reviewRequirementForScoreChange({
    role: 'Senior Analyst',
    automatedScore: 72,
    manualFinalScore: 45,
    analystNotes: 'Reviewed invoice, delivery records, RFI response and merchant trading profile.',
  });
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.loweredRiskBand, true);
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

function testReconciliationComponentDiscrepancy() {
  const result = buildReconciliationResult({
    actualMccContribution: 25, actualProfileContribution: 10, actualDetectionContribution: 15, actualScore: 50,
    manualMccContribution: 20, manualProfileContribution: 10, manualDetectionContribution: 15, manualFinalScore: 50,
  });
  assert.strictEqual(result.discrepancyFlag, true);
  assert.match(result.discrepancyNotes, /MCC: expected 25, entered 20/);
  assert.doesNotMatch(result.discrepancyNotes, /Final:/);
  assert.strictEqual(result.mismatches.length, 1);
}

function testReconciliationTreatsNullActualsAsZero() {
  const result = buildReconciliationResult({
    actualMccContribution: null, actualProfileContribution: null, actualDetectionContribution: null, actualScore: null,
    manualMccContribution: 0, manualProfileContribution: 0, manualDetectionContribution: 0, manualFinalScore: 0,
  });
  assert.strictEqual(result.discrepancyFlag, false);
}

function testCddGateBlocksAnalystWhenEddIncomplete() {
  const result = cddGateRequirement({
    role: 'Analyst',
    cddContext: {
      cddComplete: true, eddRequired: true, eddComplete: false, reviewOverdue: false,
    },
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.status, 403);
  assert.match(result.message, /EDD checklist is incomplete/);
}

function testCddGateBlocksAnalystWhenReviewOverdue() {
  const result = cddGateRequirement({
    role: 'Analyst',
    cddContext: {
      cddComplete: true, eddRequired: true, eddComplete: true, reviewOverdue: true,
    },
  });
  assert.strictEqual(result.allowed, false);
  assert.match(result.message, /CDD review date has passed/);
}

function testCddGateBlocksMediumCaseWithIncompleteCdd() {
  const result = cddGateRequirement({
    role: 'Analyst',
    cddContext: {
      cddComplete: false, eddRequired: false, eddComplete: false, reviewOverdue: false,
    },
  });
  assert.strictEqual(result.allowed, false);
  assert.match(result.message, /CDD is incomplete/);
}

function testCddGateAllowsAnalystWhenNothingOutstanding() {
  const result = cddGateRequirement({
    role: 'Analyst',
    cddContext: {
      cddComplete: true, eddRequired: true, eddComplete: true, reviewOverdue: false,
    },
  });
  assert.strictEqual(result.allowed, true);
}

function testCddGateBlocksSeniorAnalystWhenCddIncomplete() {
  const result = cddGateRequirement({
    role: 'Senior Analyst',
    cddContext: {
      cddComplete: false, eddRequired: true, eddComplete: true, reviewOverdue: false,
    },
  });
  assert.strictEqual(result.allowed, false);
  assert.match(result.message, /CDD is incomplete/);
}

async function main() {
  suite('Resolve Workflow');
  await runTest('parses required whole numbers for manual reconciliation fields', testParseRequiredWholeNumber);
  await runTest('calculates final score from contributions with cap at 100', testCalculateFinalScoreFromContributions);
  await runTest('allows same-band small final-score changes', testReviewRequirementAllowsSameBandSmallChange);
  await runTest('requires detailed notes for large score changes', testReviewRequirementNeedsDetailedNotesForLargeChange);
  await runTest('blocks Analyst from lowering the risk band', testReviewRequirementBlocksAnalystLoweringRiskBand);
  await runTest('allows Senior Analyst to lower risk band with detail', testReviewRequirementAllowsSeniorLoweringRiskBandWithDetail);
  await runTest('reports no discrepancy when manual entry matches the automated calculation', testReconciliationMatch);
  await runTest('reports a discrepancy with details when manual contribution entry differs', testReconciliationComponentDiscrepancy);
  await runTest('treats an unset actual contribution as zero, not a forced mismatch', testReconciliationTreatsNullActualsAsZero);
  await runTest('CDD gate blocks an Analyst from resolving when EDD is incomplete', testCddGateBlocksAnalystWhenEddIncomplete);
  await runTest('CDD gate blocks an Analyst from resolving when the CDD review is overdue', testCddGateBlocksAnalystWhenReviewOverdue);
  await runTest('CDD gate blocks a Medium case when CDD is incomplete', testCddGateBlocksMediumCaseWithIncompleteCdd);
  await runTest('CDD gate allows an Analyst to resolve when nothing is outstanding', testCddGateAllowsAnalystWhenNothingOutstanding);
  await runTest('CDD gate blocks a Senior Analyst when CDD is incomplete', testCddGateBlocksSeniorAnalystWhenCddIncomplete);
  finish();
}

main();
