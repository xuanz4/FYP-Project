// Multer config for CDD/EDD supporting documents. Files land flat on local disk under
// <project-root>/uploads/cdd/ - deliberately outside /public (see app.js's express.static), so a
// file is only reachable through the authenticated download route in documentsController.js,
// never by guessing a static URL. Every upload route is transaction-scoped; database metadata
// binds each generated filename to that transaction and its current case.
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const transactionModel = require('../../models/transactionModel');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'cdd');
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const DOCUMENT_TYPE_PATTERNS = {
  'Business Registration': /(?:business[\s._-]*(?:registration|profile)|acra|incorporation)/i,
  'Source of Funds': /(?:source[\s._-]*of[\s._-]*funds|\bsof\b)/i,
  'Site Visit': /(?:site[\s._-]*visit|premises[\s._-]*visit)/i,
  'Enhanced Verification': /(?:enhanced[\s._-]*verification|(?:^|[\s._-])edd(?:[\s._-]|$))/i,
  Screening: /(?:screening|sanctions?|pep|adverse[\s._-]*media)/i,
};
const MERCHANT_NOISE_WORDS = new Set([
  'pte', 'ltd', 'limited', 'private', 'company', 'singapore', 'sg', 'merchant', 'store', 'shop',
  'mart',
]);
const CDD_DOCUMENT_TYPES = new Set(['Business Registration', 'Screening']);
const EDD_DOCUMENT_TYPES = new Set(['Source of Funds', 'Site Visit', 'Enhanced Verification']);

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Recreate the private upload directory if it was removed while the app was running.
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    cb(null, UPLOAD_ROOT);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const readableBase = path.basename(file.originalname, ext)
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]|[-.]$/g, '')
      .slice(0, 100) || 'due-diligence-document';
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
    cb(null, `${readableBase}-${timestamp}${ext}`);
  },
});

function normalizeIdentifier(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function filenameContainsMerchant(originalFilename, merchantName, merchantId) {
  const normalizedFilename = normalizeIdentifier(path.basename(originalFilename, path.extname(originalFilename)));
  if (!normalizedFilename) return false;

  const normalizedMerchantId = normalizeIdentifier(merchantId);
  if (normalizedMerchantId && normalizedFilename.includes(normalizedMerchantId)) return true;

  const merchantTokens = String(merchantName || '')
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !MERCHANT_NOISE_WORDS.has(token));
  return merchantTokens.some((token) => normalizedFilename.includes(normalizeIdentifier(token)));
}

function validateUploadFilename({ originalFilename, documentType, role, merchantName, merchantId }) {
  const isCddLabel = /(?:^|[\s._-])cdd(?:[\s._-]|$)/i.test(originalFilename);
  const isEddLabel = /(?:^|[\s._-])edd(?:[\s._-]|$)/i.test(originalFilename);

  if (role === 'Analyst' && (!CDD_DOCUMENT_TYPES.has(documentType) || isEddLabel || !isCddLabel)) {
    return 'Analysts may only upload CDD documents. Choose Business Registration or Screening and use a filename beginning with "CDD".';
  }
  if (role === 'Senior Analyst' && (!EDD_DOCUMENT_TYPES.has(documentType) || isCddLabel || !isEddLabel)) {
    return 'Senior Analysts may only upload EDD documents. Choose Source of Funds, Site Visit, or Enhanced Verification and use a filename beginning with "EDD".';
  }

  const expectedPattern = DOCUMENT_TYPE_PATTERNS[documentType];
  if (expectedPattern && !expectedPattern.test(originalFilename)) {
    return `The selected document type is "${documentType}", but the filename does not match it. Select the correct type or upload the correct file.`;
  }

  if (!filenameContainsMerchant(originalFilename, merchantName, merchantId)) {
    return `This file does not appear to belong to ${merchantName || merchantId}. Upload a file whose name includes "${merchantName || merchantId}" or the merchant ID.`;
  }

  return null;
}

async function loadExpectedMerchant(req) {
  return transactionModel.findMerchantByTransactionId(req.params.id);
}

async function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(new Error('Only PDF, JPG, or PNG files are accepted.'));
    return;
  }

  try {
    const merchant = await loadExpectedMerchant(req);
    if (!merchant) {
      cb(new Error('The merchant for this upload could not be found.'));
      return;
    }

    const validationError = validateUploadFilename({
      originalFilename: file.originalname,
      documentType: String(req.body.documentType || '').trim(),
      role: req.session?.user?.role,
      merchantName: merchant.merchant_name,
      merchantId: merchant.merchant_id,
    });
    if (validationError) {
      cb(new Error(validationError));
      return;
    }
    cb(null, true);
  } catch (error) {
    console.error('Unable to validate due-diligence upload', { message: error.message });
    cb(new Error('The file could not be validated against the current merchant. Please try again.'));
  }
}

const cddDocumentUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
}).single('document');

function uploadCddDocument(req, res, next) {
  cddDocumentUpload(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'The file is larger than the 5MB limit.'
      : error.message;
    if (String(req.get('accept') || '').includes('application/json')) {
      res.status(400).json({ success: false, message });
      return;
    }
    res.status(400).type('text/plain').send(`Upload rejected: ${message}`);
  });
}

module.exports = {
  uploadCddDocument,
  UPLOAD_ROOT,
  filenameContainsMerchant,
  validateUploadFilename,
};
