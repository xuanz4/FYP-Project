const express = require('express');
const { requireRole } = require('../src/middleware/auth');
const adminController = require('../controllers/adminController');

const router = express.Router();

router.get('/admin', requireRole('Admin'), adminController.dashboard);
router.get('/admin/users', requireRole('Admin'), adminController.usersPage);
router.get('/admin/merchants', requireRole('Admin'), adminController.merchantsPage);
router.get('/admin/rules', requireRole('Admin'), adminController.rulesPage);
router.get('/admin/audit-log', requireRole('Admin'), adminController.auditLogPage);

router.post('/admin/users', requireRole('Admin'), adminController.createUser);
router.post('/admin/users/:id', requireRole('Admin'), adminController.updateUser);
router.post('/admin/users/:id/toggle', requireRole('Admin'), adminController.toggleUser);
router.post('/admin/users/:id/delete', requireRole('Admin'), adminController.deleteUser);

router.post('/admin/merchants', requireRole('Admin'), adminController.createMerchant);
router.post('/admin/merchants/:id', requireRole('Admin'), adminController.updateMerchant);
router.post('/admin/merchants/:id/delete', requireRole('Admin'), adminController.deleteMerchant);
router.post('/admin/merchants/:id/edd-checklist', requireRole('Admin'), adminController.updateEddChecklist);
router.post('/admin/merchants/:id/beneficial-owners', requireRole('Admin'), adminController.addBeneficialOwner);
router.post('/admin/merchants/:id/beneficial-owners/:ownerId/delete', requireRole('Admin'), adminController.deleteBeneficialOwner);
router.post('/admin/merchants/:id/screening', requireRole('Admin'), adminController.addScreeningRecord);

router.post('/admin/rules', requireRole('Admin'), adminController.createRule);
router.post('/admin/rules/:id', requireRole('Admin'), adminController.updateRule);
router.post('/admin/rules/:id/delete', requireRole('Admin'), adminController.deleteRule);

module.exports = router;
