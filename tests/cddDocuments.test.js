const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { saveCddDocument, listCddDocuments, getCddDocument, DOCUMENT_TYPES } = require('../src/lib/cddDocuments');

function fakeDatabase({ queryResult = [] } = {}) {
  const executed = [];
  const queried = [];
  return {
    executed,
    queried,
    async execute(sql, params) {
      executed.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
    async query(sql, params) {
      queried.push({ sql, params });
      return [queryResult];
    },
  };
}

async function testSaveCddDocumentInsertsRowAndReturnsId() {
  const db = fakeDatabase();
  const documentId = await saveCddDocument(db, {
    merchantId: 'M-10502',
    transactionId: 'TX-001',
    caseId: 'CASE-001',
    documentType: 'Source of Funds',
    originalFilename: 'bank-statement.pdf',
    storedFilename: 'abc123.pdf',
    mimeType: 'application/pdf',
    fileSize: 4096,
    notes: 'Reviewed June statement',
    uploadedBy: 'USR-001',
  });

  assert.ok(documentId.startsWith('DOC-'));
  assert.strictEqual(db.executed.length, 1);
  assert.match(db.executed[0].sql, /INSERT INTO merchant_cdd_documents/);
  assert.deepStrictEqual(db.executed[0].params, [
    documentId, 'M-10502', 'TX-001', 'CASE-001', 'Source of Funds', 'bank-statement.pdf', 'abc123.pdf', 'application/pdf', 4096, 'Reviewed June statement', 'USR-001',
  ]);
}

async function testSaveCddDocumentDefaultsMissingNotesToNull() {
  const db = fakeDatabase();
  await saveCddDocument(db, {
    merchantId: 'M-1',
    transactionId: 'TX-002',
    caseId: 'CASE-002',
    documentType: 'Other',
    originalFilename: 'a.png',
    storedFilename: 'b.png',
    mimeType: 'image/png',
    fileSize: 10,
    notes: '',
    uploadedBy: 'USR-004',
  });
  assert.strictEqual(db.executed[0].params[9], null);
}

async function testListCddDocumentsQueriesByTransactionOrderedByRecency() {
  const rows = [{ document_id: 'DOC-1', merchant_id: 'M-1', transaction_id: 'TX-001' }];
  const db = fakeDatabase({ queryResult: rows });
  const result = await listCddDocuments(db, 'TX-001');
  assert.deepStrictEqual(result, rows);
  assert.match(db.queried[0].sql, /FROM merchant_cdd_documents WHERE transaction_id = \?/);
  assert.match(db.queried[0].sql, /ORDER BY uploaded_at DESC/);
  assert.deepStrictEqual(db.queried[0].params, ['TX-001']);
}

async function testGetCddDocumentReturnsNullWhenNotFound() {
  const db = fakeDatabase({ queryResult: [] });
  const result = await getCddDocument(db, 'DOC-MISSING');
  assert.strictEqual(result, null);
}

async function testGetCddDocumentReturnsRowWhenFound() {
  const row = { document_id: 'DOC-1', stored_filename: 'abc.pdf' };
  const db = fakeDatabase({ queryResult: [row] });
  const result = await getCddDocument(db, 'DOC-1');
  assert.deepStrictEqual(result, row);
}

function testDocumentTypesCoversEveryEddChecklistCategory() {
  assert.deepStrictEqual(DOCUMENT_TYPES, ['Business Registration', 'Screening', 'Source of Funds', 'Site Visit', 'Enhanced Verification', 'Other']);
}

async function main() {
  suite('CDD Documents');
  await runTest('saves a document record and returns a generated ID', testSaveCddDocumentInsertsRowAndReturnsId);
  await runTest('defaults missing notes to null', testSaveCddDocumentDefaultsMissingNotesToNull);
  await runTest('lists documents for one transaction ordered by recency', testListCddDocumentsQueriesByTransactionOrderedByRecency);
  await runTest('returns null when a document is not found', testGetCddDocumentReturnsNullWhenNotFound);
  await runTest('returns the row when a document is found', testGetCddDocumentReturnsRowWhenFound);
  await runTest('exposes the fixed document type list', testDocumentTypesCoversEveryEddChecklistCategory);
  finish();
}

main();
