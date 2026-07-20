const express = require('express');
const { requireRole } = require('../src/middleware/auth');
const seniorAnalystController = require('../controllers/seniorAnalystController');

const router = express.Router();

router.get('/senior-analyst', requireRole('Senior Analyst'), seniorAnalystController.dashboard);
router.get('/senior-analyst/cases', requireRole('Senior Analyst'), seniorAnalystController.casesPage);
router.get('/senior-analyst/audit-log', requireRole('Senior Analyst'), seniorAnalystController.auditLogPage);
router.post('/senior-analyst/cases/:id/action', requireRole('Senior Analyst'), seniorAnalystController.caseAction);

module.exports = router;
