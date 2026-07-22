const express = require('express');
const { requireAuth } = require('../src/middleware/auth');
const { handleDatabaseRfiRequest } = require('../src/lib/rfiWorkflow');
const { handleDatabaseResolveRequest } = require('../src/lib/resolveWorkflow');
const transactionsController = require('../controllers/transactionsController');

const router = express.Router();

router.get('/transactions/:id', requireAuth, transactionsController.transactionDetailPage);

router.patch('/api/cases/:caseId/assign-to-me', requireAuth, transactionsController.assignToMe);
router.post('/api/transactions/:id/refer-to-stro', requireAuth, transactionsController.referToStro);
router.post('/api/transactions/:id/escalate', requireAuth, transactionsController.escalate);
router.patch('/api/transactions/:id/str', requireAuth, transactionsController.fileStr);
router.post('/api/transactions/:id/str/not-required', requireAuth, transactionsController.strNotRequired);

router.get('/app.js', transactionsController.liveRefreshScript);

router.post('/api/transactions', transactionsController.ingestTransactionEndpoint);
router.get('/api/transactions/:id/rfi/latest-response', requireAuth, transactionsController.latestRfiResponseEndpoint);
router.post('/api/transactions/:id/rfi', (req, res) => handleDatabaseRfiRequest(req, res));
router.patch('/api/transactions/:id/resolve', (req, res) => handleDatabaseResolveRequest(req, res));

router.use('/api', transactionsController.apiNotFound);

module.exports = router;
