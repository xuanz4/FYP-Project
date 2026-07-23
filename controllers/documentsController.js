// Transaction-scoped authenticated download point. The transaction ID in the URL must match
// the document metadata, preventing a link copied from one case being reused under another.
const path = require('path');
const database = require('../src/database');
const { getCddDocument } = require('../src/lib/cddDocuments');
const { UPLOAD_ROOT } = require('../src/middleware/upload');

async function downloadDocument(req, res) {
  const document = await getCddDocument(database, req.params.id);
  if (!document || document.transaction_id !== req.params.transactionId) {
    return res.status(404).send('Document not found for this transaction');
  }

  const filePath = path.join(UPLOAD_ROOT, document.stored_filename);
  return res.download(filePath, document.original_filename, (error) => {
    if (error && !res.headersSent) res.status(404).send('Document file not found on disk');
  });
}

module.exports = { downloadDocument };
