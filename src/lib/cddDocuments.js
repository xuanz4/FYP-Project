// Shared read/write path for merchant_cdd_documents (see schema.js's ensureMerchantCddSchema).
// Mirrors eddChecklist.js's shape: a single write function every caller (adminController.js,
// transactionsController.js) goes through, and which document_type a caller may write is
// enforced by the caller, not here.
const database = require('../database');
const { id } = require('./ids');

const DOCUMENT_TYPES = ['Business Registration', 'Screening', 'Source of Funds', 'Site Visit', 'Enhanced Verification', 'Other'];

async function saveCddDocument(db, {
  merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes, uploadedBy,
}) {
  if (!transactionId || !caseId) throw new Error('Transaction and case are required for supporting documents');
  const client = db || database;
  const documentId = id('DOC');
  await client.execute(
    `INSERT INTO merchant_cdd_documents
       (document_id, merchant_id, transaction_id, case_id, document_type, original_filename, stored_filename, mime_type, file_size, notes, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [documentId, merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes || null, uploadedBy],
  );
  return documentId;
}

async function listCddDocuments(db, transactionId) {
  const client = db || database;
  const [rows] = await client.query(
    `SELECT document_id, merchant_id, transaction_id, case_id, document_type, original_filename, mime_type, file_size, notes, uploaded_by, uploaded_at
     FROM merchant_cdd_documents WHERE transaction_id = ? ORDER BY uploaded_at DESC`,
    [transactionId],
  );
  return rows;
}

async function getCddDocument(db, documentId) {
  const client = db || database;
  const [rows] = await client.query(
    'SELECT * FROM merchant_cdd_documents WHERE document_id = ? LIMIT 1',
    [documentId],
  );
  return rows[0] || null;
}

module.exports = {
  DOCUMENT_TYPES, saveCddDocument, listCddDocuments, getCddDocument,
};
