const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  getRiskLevelFromScore,
  parseFinalRiskScore,
  hasMeaningfulAnalystNotes,
  hasMeaningfulText,
  normalizeEvidence,
  formatSqlDateTime,
  buildTransactionSummary,
  buildStrAutoFill,
} = require('../src/lib/strDraft');

function testRiskScoreParsing() {
  assert.strictEqual(getRiskLevelFromScore(29), 'Low');
  assert.strictEqual(getRiskLevelFromScore(30), 'Medium');
  assert.strictEqual(getRiskLevelFromScore(50), 'High');
  assert.strictEqual(getRiskLevelFromScore(70), 'Critical');

  assert.strictEqual(parseFinalRiskScore('0'), 0);
  assert.strictEqual(parseFinalRiskScore('100'), 100);
  assert.strictEqual(parseFinalRiskScore(45), 45);
  assert.strictEqual(parseFinalRiskScore('45.5'), null);
  assert.strictEqual(parseFinalRiskScore('-1'), null);
  assert.strictEqual(parseFinalRiskScore('101'), null);
  assert.strictEqual(parseFinalRiskScore(''), null);
}

function testRiskLevelMappingBoundaries() {
  assert.strictEqual(getRiskLevelFromScore(0), 'Low');
  assert.strictEqual(getRiskLevelFromScore(30), 'Medium');
  assert.strictEqual(getRiskLevelFromScore(50), 'High');
  assert.strictEqual(getRiskLevelFromScore(70), 'Critical');
}

function testFinalRiskScoreRejectsNonWholeNumbers() {
  assert.strictEqual(parseFinalRiskScore('99'), 99);
  assert.strictEqual(parseFinalRiskScore('99.1'), null);
  assert.strictEqual(parseFinalRiskScore('abc'), null);
  assert.strictEqual(parseFinalRiskScore('  '), 0);
}

function testMeaningfulTextValidation() {
  assert.strictEqual(hasMeaningfulAnalystNotes('Please verify invoice'), true);
  assert.strictEqual(hasMeaningfulAnalystNotes('testing'), false);
  assert.strictEqual(hasMeaningfulAnalystNotes('too short'), false);
  assert.strictEqual(hasMeaningfulText('Detailed senior review note', 20), true);
  assert.strictEqual(hasMeaningfulText('n/a', 2), false);
}

function testMeaningfulTextNormalizesWhitespace() {
  assert.strictEqual(hasMeaningfulAnalystNotes('   Verified    invoice record   '), true);
  assert.strictEqual(hasMeaningfulText('   Detailed     note value   ', 15), true);
  assert.strictEqual(hasMeaningfulText('   na   ', 2), false);
}

function testEvidenceAndFormatting() {
  assert.deepStrictEqual(
    normalizeEvidence(['Transaction behaviour', 'Unknown', 'RFI response', '']),
    ['Transaction behaviour', 'RFI response'],
  );
  assert.strictEqual(formatSqlDateTime('2026-07-21T14:30:45.999Z'), '2026-07-21 14:30:45');
}

function testNormalizeEvidenceAcceptsSingleValue() {
  assert.deepStrictEqual(normalizeEvidence('RFI response'), ['RFI response']);
  assert.deepStrictEqual(normalizeEvidence('Unknown'), []);
  assert.deepStrictEqual(normalizeEvidence(null), []);
}

function testSqlDateFormattingDropsMilliseconds() {
  assert.strictEqual(formatSqlDateTime(new Date('2026-07-21T14:30:45.999Z')), '2026-07-21 14:30:45');
}

function testTransactionSummary() {
  const summary = buildTransactionSummary({
    transaction_id: 'TXN-001',
    created_at: '2026-07-21T08:15:00Z',
    amount: 1250,
    currency: 'SGD',
    direction: 'Local card payment',
    merchant_name: 'Demo Merchant',
    counterparty_country: 'Singapore',
  });
  assert.match(summary, /Transaction ID: TXN-001/);
  assert.match(summary, /Amount: SGD 1250\.00/);
  assert.match(summary, /Counterparty: Demo Merchant/);
}

function testTransactionSummaryUsesFallbacks() {
  const summary = buildTransactionSummary({
    id: 'RAW-001',
    amount: null,
  });
  assert.match(summary, /Transaction ID: RAW-001/);
  assert.match(summary, /Amount: SGD 0\.00/);
  assert.match(summary, /Counterparty: Merchant/);
  assert.match(summary, /Counterparty country: Singapore/);
}

function testStrAutoFill() {
  const draft = buildStrAutoFill({
    transaction: {
      transaction_id: 'TXN-STR-001',
      created_at: '2026-07-21T08:15:00Z',
      amount: 9800,
      currency: 'SGD',
      merchant_name: 'Demo Merchant',
      risk_level: 'High',
      risk_score: 65,
      mcc_risk_score: 10,
    },
    caseRecord: {
      referral_reason: 'High-risk activity pattern',
      referral_summary: 'Repeated transactions require review.',
      senior_analyst_notes: 'Escalated for STRO decision.',
    },
    matchedRules: [
      {
        rule_name: 'Near Threshold Structuring',
        risk_level: 'High',
        weight: 35,
        reason: 'Repeated near-threshold activity',
        rule_type: 'near_threshold',
      },
    ],
    activityLogs: [{ action: 'Request for Information Sent' }],
  });

  assert.match(draft.referenceNumber, /^STR-TXN-STR-001-\d{8}$/);
  assert.match(draft.reportingReason, /Near Threshold Structuring/);
  assert.match(draft.suspicionSummary, /Repeated near-threshold activity/);
  assert.match(draft.stroNotes, /Confirmed 1 monitoring rule match/);
  assert.ok(draft.supportingEvidence.includes('Triggered monitoring rules'));
  assert.ok(draft.supportingEvidence.includes('RFI response'));
}

function testStrAutoFillWithoutMatchedRules() {
  const draft = buildStrAutoFill({
    transaction: {
      transaction_id: 'TXN-NO-RULE',
      amount: 25,
      risk_level: 'Medium',
      risk_score: 35,
      mcc_risk_score: 0,
    },
    caseRecord: {},
    matchedRules: [],
    activityLogs: [],
  });

  assert.match(draft.reportingReason, /triggering 0 monitoring rules/);
  assert.match(draft.stroNotes, /No monitoring rules were recorded/);
  assert.deepStrictEqual(draft.supportingEvidence, []);
}

async function main() {
  suite('STR Draft Helpers');
  await runTest('parses final risk scores and maps risk bands', testRiskScoreParsing);
  await runTest('maps score boundaries to STR risk bands', testRiskLevelMappingBoundaries);
  await runTest('rejects non-whole final risk score input', testFinalRiskScoreRejectsNonWholeNumbers);
  await runTest('rejects weak notes and accepts meaningful text', testMeaningfulTextValidation);
  await runTest('normalizes whitespace before checking meaningful notes', testMeaningfulTextNormalizesWhitespace);
  await runTest('normalizes evidence and formats SQL date time', testEvidenceAndFormatting);
  await runTest('normalizes single evidence values and ignores invalid values', testNormalizeEvidenceAcceptsSingleValue);
  await runTest('formats SQL date time without milliseconds', testSqlDateFormattingDropsMilliseconds);
  await runTest('builds transaction summary text', testTransactionSummary);
  await runTest('builds transaction summary text with safe fallbacks', testTransactionSummaryUsesFallbacks);
  await runTest('builds STR auto-fill draft from case context', testStrAutoFill);
  await runTest('builds STR draft text when no matched rules exist', testStrAutoFillWithoutMatchedRules);
  finish();
}

main();
