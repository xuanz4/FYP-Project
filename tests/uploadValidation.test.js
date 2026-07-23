const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  filenameContainsMerchant,
  validateUploadFilename,
} = require('../src/middleware/upload');

function testMatchesCorrectMerchant() {
  assert.strictEqual(filenameContainsMerchant('CDD - Screening - FamilyMart.pdf', 'FamilyMart Singapore Pte Ltd', 'M-100'), true);
  assert.strictEqual(filenameContainsMerchant('CDD - Screening - M-100.pdf', 'FamilyMart Singapore Pte Ltd', 'M-100'), true);
  assert.strictEqual(filenameContainsMerchant('CDD - Screening - GoldMart.pdf', 'FamilyMart Singapore Pte Ltd', 'M-100'), false);
}

function testRejectsAnalystEddFilename() {
  const message = validateUploadFilename({
    originalFilename: 'EDD - Site Visit Report - FamilyMart.pdf',
    documentType: 'Site Visit',
    role: 'Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.match(message, /Analysts may only upload CDD documents/);
}

function testRejectsWrongDocumentType() {
  const message = validateUploadFilename({
    originalFilename: 'EDD - Site Visit Report - FamilyMart.pdf',
    documentType: 'Source of Funds',
    role: 'Senior Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.match(message, /filename does not match/);
}

function testRejectsWrongMerchant() {
  const message = validateUploadFilename({
    originalFilename: 'CDD - Business Registration - GoldMart.pdf',
    documentType: 'Business Registration',
    role: 'Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.match(message, /does not appear to belong to FamilyMart/);
}

function testAcceptsMatchingFile() {
  const message = validateUploadFilename({
    originalFilename: 'CDD - Business Registration - FamilyMart.pdf',
    documentType: 'Business Registration',
    role: 'Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.strictEqual(message, null);
}

function testSeniorAnalystAcceptsEddFile() {
  const message = validateUploadFilename({
    originalFilename: 'EDD - Source of Funds - FamilyMart.pdf',
    documentType: 'Source of Funds',
    role: 'Senior Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.strictEqual(message, null);
}

function testSeniorAnalystRejectsCddFile() {
  const message = validateUploadFilename({
    originalFilename: 'CDD - Screening - FamilyMart.pdf',
    documentType: 'Screening',
    role: 'Senior Analyst',
    merchantName: 'FamilyMart Singapore Pte Ltd',
    merchantId: 'M-100',
  });
  assert.match(message, /Senior Analysts may only upload EDD documents/);
}

async function main() {
  suite('Due-Diligence Upload Validation');
  await runTest('matches filenames to the current merchant', testMatchesCorrectMerchant);
  await runTest('rejects EDD-labelled files uploaded by Analysts', testRejectsAnalystEddFilename);
  await runTest('rejects a filename that conflicts with the selected document type', testRejectsWrongDocumentType);
  await runTest('rejects a document for a different merchant', testRejectsWrongMerchant);
  await runTest('accepts a matching CDD filename for the current merchant', testAcceptsMatchingFile);
  await runTest('accepts a matching EDD filename for a Senior Analyst', testSeniorAnalystAcceptsEddFile);
  await runTest('rejects a CDD file uploaded by a Senior Analyst', testSeniorAnalystRejectsCddFile);
  finish();
}

main();
