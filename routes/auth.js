const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../src/middleware/auth');

const router = express.Router();

router.get('/login', authController.loginPage);
router.post('/auth/login', authController.login);
router.get('/logout', authController.logout);
router.get('/', requireAuth, authController.home);
router.get('/dashboard', requireAuth, authController.home);

module.exports = router;
