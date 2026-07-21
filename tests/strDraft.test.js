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

function testMeaningfulTextValidation() {
  assert.strictEqual(hasMeaningfulAnalystNotes('Please verify invoice'), true);
  assert.strictEqual(hasMeaningfulAnalystNotes('testing'), false);
  assert.strictEqual(hasMeaningfulAnalystNotes('too short'), false);
  assert.strictEqual(hasMeaningfulText('Detailed senior review note', 20), true);
  assert.strictEqual(hasMeaningfulText('n/a', 2), false);
}

function testEvidenceAndFormatting() {
  assert.deepStrictEqual(
    normalizeEvidence(['Transaction behaviour', 'Unknown', 'RFI response', '']),
    ['Transaction behaviour', 'RFI response'],
  );
  assert.strictEqual(formatSqlDateTime('2026-07-21T14:30:45.999Z'), '2026-07-21 14:30:45');
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

async function main() {
  suite('STR Draft Helpers');
  await runTest('parses final risk scores and maps risk bands', testRiskScoreParsing);
  await runTest('rejects weak notes and accepts meaningful text', testMeaningfulTextValidation);
  await runTest('normalizes evidence and formats SQL date time', testEvidenceAndFormatting);
  await runTest('builds transaction summary text', testTransactionSummary);
  await runTest('builds STR auto-fill draft from case context', testStrAutoFill);
  finish();
}

main();
