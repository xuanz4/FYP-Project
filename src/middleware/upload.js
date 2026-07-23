// Multer config for CDD/EDD supporting documents. Files land flat on local disk under
// <project-root>/uploads/cdd/ - deliberately outside /public (see app.js's express.static), so a
// file is only reachable through the authenticated download route in documentsController.js,
// never by guessing a static URL. Flat (not nested per-merchant) because the two upload routes
// that use this middleware key their URL param on different things (:id is a merchant ID on the
// admin route, a transaction ID on the case-workspace route) - the generated filename is unique
// enough on its own, and downloads are resolved by document_id -> stored_filename, not by path.
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'cdd');
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const generatedName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, generatedName);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(new Error('Only PDF, JPG, or PNG files are accepted.'));
    return;
  }
  cb(null, true);
}

const uploadCddDocument = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
}).single('document');

module.exports = { uploadCddDocument, UPLOAD_ROOT };
