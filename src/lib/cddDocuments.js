// Shared read/write path for merchant_cdd_documents (see schema.js's ensureMerchantCddSchema).
// Mirrors eddChecklist.js's shape: a single write function every caller (adminController.js,
// transactionsController.js) goes through, and which document_type a caller may write is
// enforced by the caller, not here.
const { id } = require('./ids');
const cddDocumentModel = require('../../models/cddDocumentModel');

const DOCUMENT_TYPES = ['Business Registration', 'Screening', 'Source of Funds', 'Site Visit', 'Enhanced Verification', 'Other'];

async function saveCddDocument(db, {
  merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes, uploadedBy,
}) {
  if (!transactionId || !caseId) throw new Error('Transaction and case are required for supporting documents');
  const documentId = id('DOC');
  await cddDocumentModel.insert(db, {
    documentId, merchantId, transactionId, caseId, documentType, originalFilename, storedFilename, mimeType, fileSize, notes, uploadedBy,
  });
  return documentId;
}

async function listCddDocuments(db, transactionId) {
  return cddDocumentModel.listByTransactionId(db, transactionId);
}

async function getCddDocument(db, documentId) {
  return cddDocumentModel.findById(db, documentId);
}

module.exports = {
  DOCUMENT_TYPES, saveCddDocument, listCddDocuments, getCddDocument,
};
