const database = require('../src/database');

// Accepts an optional db client (see merchantModel.findRiskTierById) so callers that inject
// their own (controllers pass the real database; tests pass a fake) share this seam.
async function insert(db, {
  documentId, merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes, uploadedBy,
}) {
  const client = db || database;
  await client.execute(
    `INSERT INTO merchant_cdd_documents
       (document_id, merchant_id, transaction_id, case_id, document_type, original_filename, stored_filename, mime_type, file_size, notes, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [documentId, merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes || null, uploadedBy],
  );
}

async function listByTransactionId(db, transactionId) {
  const client = db || database;
  const [rows] = await client.query(
    `SELECT document_id, merchant_id, transaction_id, case_id, document_type, original_filename, mime_type, file_size, notes, uploaded_by, uploaded_at
     FROM merchant_cdd_documents WHERE transaction_id = ? ORDER BY uploaded_at DESC`,
    [transactionId],
  );
  return rows;
}

async function findById(db, documentId) {
  const client = db || database;
  const [rows] = await client.query(
    'SELECT * FROM merchant_cdd_documents WHERE document_id = ? LIMIT 1',
    [documentId],
  );
  return rows[0] || null;
}

module.exports = { insert, listByTransactionId, findById };
