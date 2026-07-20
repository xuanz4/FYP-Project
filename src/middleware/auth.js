function roleHomePath(role) {
  return {
    Admin: '/admin',
    Analyst: '/analyst',
    'Senior Analyst': '/senior-analyst',
    STRO: '/stro',
  }[role] || '/login';
}

function activePageForRole(role) {
  return {
    Admin: 'admin',
    Analyst: 'analyst',
    'Senior Analyst': 'senior-analyst',
    STRO: 'stro',
  }[role] || 'analyst';
}

function authRedirect(req, res, next) {
  const publicPaths = [
    '/login',
    '/auth/login',
    '/logout',
    '/styles.css',
    '/app.js',
    '/images',
  ];

  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (publicPaths.some((pathPrefix) => req.path === pathPrefix || req.path.startsWith(`${pathPrefix}/`))) {
    return next();
  }

  if (!req.session.user) {
    return res.redirect('/login');
  }

  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden');
    }
    return next();
  };
}

function roleCanPerform(role, action) {
  const permissions = {
    sendRfi: ['Analyst', 'Senior Analyst', 'STRO'],
    escalateCase: ['Analyst', 'Senior Analyst'],
    resolveCase: ['Analyst', 'Senior Analyst'],
    fileStr: ['STRO'],
    manageRules: ['Admin'],
  };
  return (permissions[action] || []).includes(role);
}

function forbidJson(res) {
  return res.status(403).json({
    success: false,
    message: 'You do not have permission to perform this action.',
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  return next();
}

module.exports = {
  roleHomePath,
  activePageForRole,
  authRedirect,
  requireRole,
  roleCanPerform,
  forbidJson,
  requireAuth,
};
