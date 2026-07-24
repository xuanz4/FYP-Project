const userModel = require('../models/userModel');
const { roleHomePath } = require('../src/middleware/auth');

function renderLogin(req, res, error = null) {
  if (req.session.user) return res.redirect(roleHomePath(req.session.user.role));
  return res.render('login', { title: 'Login', layout: 'login', error });
}

function loginPage(req, res) {
  return renderLogin(req, res);
}

async function login(req, res) {
  try {
    const userId = String(req.body.userId || '').trim();
    const password = String(req.body.password || '');
    if (!userId || !password) return renderLogin(req, res, 'User ID and password are required.');

    const user = await userModel.findActiveByCredentials(userId, password);
    if (!user) return renderLogin(req, res, 'Invalid credentials or inactive account.');

    req.session.user = { id: user.user_id, name: user.user_name, role: user.user_role };
    return res.redirect(roleHomePath(user.user_role));
  } catch (error) {
    console.error('Login failed', { message: error.message });
    return renderLogin(req, res, 'Unable to sign in right now.');
  }
}

function logout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

function home(req, res) {
  return res.redirect(roleHomePath(req.session.user.role));
}

module.exports = { loginPage, login, logout, home };
