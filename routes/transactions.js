const express = require('express');
const { requireAuth, requireRole } = require('../src/middleware/auth');
const { handleDatabaseRfiRequest } = require('../src/lib/rfiWorkflow');
const { handleDatabaseResolveRequest } = require('../src/lib/resolveWorkflow');
const { uploadCddDocument } = require('../src/middleware/upload');
const transactionsController = require('../controllers/transactionsController');
const documentsController = require('../controllers/documentsController');

const router = express.Router();

router.get('/transactions/:id', requireAuth, transactionsController.transactionDetailPage);
router.get('/transactions/:transactionId/documents/:id/download', requireAuth, documentsController.downloadDocument);

router.patch('/api/cases/:caseId/assign-to-me', requireAuth, transactionsController.assignToMe);
router.post('/api/transactions/:id/refer-to-stro', requireAuth, transactionsController.referToStro);
router.post('/api/transactions/:id/escalate', requireAuth, transactionsController.escalate);
router.patch('/api/transactions/:id/str', requireAuth, transactionsController.fileStr);
router.post('/api/transactions/:id/str/not-required', requireAuth, transactionsController.strNotRequired);

router.get('/app.js', transactionsController.liveRefreshScript);

router.post('/api/transactions', transactionsController.ingestTransactionEndpoint);
router.get('/api/transactions/:id/rfi/latest-response', requireAuth, transactionsController.latestRfiResponseEndpoint);
router.post('/api/transactions/:id/rfi', (req, res) => handleDatabaseRfiRequest(req, res));
router.post('/api/transactions/:id/edd-checklist', requireAuth, transactionsController.updateCaseEddChecklist);
router.post(
  '/api/transactions/:id/cdd-documents',
  requireRole('Analyst', 'Senior Analyst'),
  uploadCddDocument,
  transactionsController.uploadCaseDocument,
);
router.post('/api/transactions/:id/rfi-evidence', requireAuth, transactionsController.logRfiEvidence);
router.patch('/api/transactions/:id/resolve', (req, res) => handleDatabaseResolveRequest(req, res));

router.use('/api', transactionsController.apiNotFound);

module.exports = router;
