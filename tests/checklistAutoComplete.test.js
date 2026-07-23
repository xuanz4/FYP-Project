const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  DOCUMENT_TYPE_ROLE_MAP,
  CDD_DOCUMENT_TYPE_TO_FIELD,
  EDD_DOCUMENT_TYPE_TO_FIELD,
} = require('../controllers/transactionsController');

// The CDD/EDD checklist is completed automatically by uploadCaseDocument when a matching
// document is uploaded (see transactionsController.js) - there is no manual "mark complete"
// form left for either checklist. These tests lock in the type->field mapping so a future
// change can't silently drop a document type from auto-completing its checklist item.

function testEveryAnalystDocumentTypeMapsToACddField() {
  DOCUMENT_TYPE_ROLE_MAP.Analyst.forEach((documentType) => {
    assert.ok(
      CDD_DOCUMENT_TYPE_TO_FIELD[documentType],
      `Analyst-uploadable document type "${documentType}" must map to a CDD checklist field`,
    );
    assert.strictEqual(
      EDD_DOCUMENT_TYPE_TO_FIELD[documentType],
      undefined,
      `Analyst-uploadable document type "${documentType}" must not also auto-complete an EDD field`,
    );
  });
}

function testEverySeniorAnalystDocumentTypeMapsToAnEddField() {
  DOCUMENT_TYPE_ROLE_MAP['Senior Analyst'].forEach((documentType) => {
    assert.ok(
      EDD_DOCUMENT_TYPE_TO_FIELD[documentType],
      `Senior-Analyst-uploadable document type "${documentType}" must map to an EDD checklist field`,
    );
    assert.strictEqual(
      CDD_DOCUMENT_TYPE_TO_FIELD[documentType],
      undefined,
      `Senior-Analyst-uploadable document type "${documentType}" must not also auto-complete a CDD field`,
    );
  });
}

function testCddFieldMapMatchesChecklistFieldKeys() {
  assert.deepStrictEqual(CDD_DOCUMENT_TYPE_TO_FIELD, {
    'Business Registration': 'businessRegistration',
    Screening: 'screening',
  });
}

function testEddFieldMapMatchesChecklistFieldKeysAndExcludesSignoff() {
  assert.deepStrictEqual(EDD_DOCUMENT_TYPE_TO_FIELD, {
    'Source of Funds': 'sourceOfFunds',
    'Site Visit': 'siteVisit',
    'Enhanced Verification': 'enhancedVerification',
  });
  // Senior Sign-off has no document type - it stays a manual attestation, never auto-completed.
  assert.ok(!Object.values(EDD_DOCUMENT_TYPE_TO_FIELD).includes('seniorSignoff'));
}

async function main() {
  suite('Checklist Auto-Complete Mapping');
  await runTest('every Analyst-uploadable document type completes a CDD field only', testEveryAnalystDocumentTypeMapsToACddField);
  await runTest('every Senior-Analyst-uploadable document type completes an EDD field only', testEverySeniorAnalystDocumentTypeMapsToAnEddField);
  await runTest('CDD document types map to the exact checklist field keys', testCddFieldMapMatchesChecklistFieldKeys);
  await runTest('EDD document types map to the exact checklist field keys, excluding sign-off', testEddFieldMapMatchesChecklistFieldKeysAndExcludesSignoff);
  finish();
}

main();
