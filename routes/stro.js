const express = require('express');
const { requireRole } = require('../src/middleware/auth');
const stroController = require('../controllers/stroController');

const router = express.Router();

router.get('/stro', requireRole('STRO'), stroController.dashboard);
router.get('/stro/cases', requireRole('STRO'), stroController.casesPage);
router.get('/stro/str-reports', requireRole('STRO'), stroController.strReportsPage);
router.get('/stro/audit-log', requireRole('STRO'), stroController.auditLogPage);
router.post('/stro/cases/:id/action', requireRole('STRO'), stroController.caseAction);

module.exports = router;
