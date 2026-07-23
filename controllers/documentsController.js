// Single authenticated download point for every merchant_cdd_documents row, regardless of
// whether it was uploaded from the Admin merchant dialog or the case workspace. Any logged-in
// role can fetch a document - the CDD panel itself is already visible to all roles (see
// transactionsController.js's transactionDetailPage comment), so gating the file behind a role
// check here would just hide the evidence for the record its caption already shows.
const path = require('path');
const database = require('../src/database');
const { getCddDocument } = require('../src/lib/cddDocuments');
const { UPLOAD_ROOT } = require('../src/middleware/upload');

async function downloadDocument(req, res) {
  const document = await getCddDocument(database, req.params.id);
  if (!document) return res.status(404).send('Document not found');

  const filePath = path.join(UPLOAD_ROOT, document.stored_filename);
  return res.download(filePath, document.original_filename, (error) => {
    if (error && !res.headersSent) res.status(404).send('Document file not found on disk');
  });
}

module.exports = { downloadDocument };
