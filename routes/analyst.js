const express = require('express');
const { requireRole } = require('../src/middleware/auth');
const analystController = require('../controllers/analystController');

const router = express.Router();

router.get('/analyst', requireRole('Analyst'), analystController.dashboard);
router.get('/analyst/live-transactions', requireRole('Analyst'), analystController.liveTransactionsPage);
router.get('/analyst/working-queue', requireRole('Analyst'), analystController.workingQueuePage);
router.get('/analyst/cases', requireRole('Analyst'), analystController.casesPage);
router.get('/analyst/audit-log', requireRole('Analyst'), analystController.auditLogPage);
router.post('/analyst/cases/:id/action', requireRole('Analyst'), analystController.caseAction);

module.exports = router;
