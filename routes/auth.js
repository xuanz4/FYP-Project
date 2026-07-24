const express = require('express');
const userModel = require('../models/userModel');
const { roleHomePath, requireAuth } = require('../src/middleware/auth');

const router = express.Router();

function renderLogin(req, res, error = null) {
  if (req.session.user) {
    return res.redirect(roleHomePath(req.session.user.role));
  }

  return res.render('login', {
    title: 'Login',
    layout: 'login',
    error,
  });
}

router.get('/login', (req, res) => renderLogin(req, res));

router.post('/auth/login', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const password = String(req.body.password || '');
    if (!userId || !password) {
      return renderLogin(req, res, 'User ID and password are required.');
    }

    const user = await userModel.findActiveByCredentials(userId, password);
    if (!user) {
      return renderLogin(req, res, 'Invalid credentials or inactive account.');
    }

    req.session.user = {
      id: user.user_id,
      name: user.user_name,
      role: user.user_role,
    };

    return res.redirect(roleHomePath(user.user_role));
  } catch (error) {
    console.error('Login failed', error);
    return renderLogin(req, res, 'Unable to sign in right now.');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.get('/', requireAuth, (req, res) => res.redirect(roleHomePath(req.session.user.role)));
router.get('/dashboard', requireAuth, (req, res) => res.redirect(roleHomePath(req.session.user.role)));

module.exports = router;
