const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const {
  roleHomePath,
  activePageForRole,
  authRedirect,
  requireRole,
  roleCanPerform,
  forbidJson,
  requireAuth,
} = require('../src/middleware/auth');

function mockResponse() {
  return {
    statusCode: 200,
    redirectPath: null,
    sentBody: null,
    jsonBody: null,
    redirect(path) {
      this.redirectPath = path;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.sentBody = body;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

function testRoleMappings() {
  assert.strictEqual(roleHomePath('Admin'), '/admin');
  assert.strictEqual(roleHomePath('Analyst'), '/analyst');
  assert.strictEqual(roleHomePath('Senior Analyst'), '/senior-analyst');
  assert.strictEqual(roleHomePath('STRO'), '/stro');
  assert.strictEqual(roleHomePath('Unknown'), '/login');

  assert.strictEqual(activePageForRole('Admin'), 'admin');
  assert.strictEqual(activePageForRole('Senior Analyst'), 'senior-analyst');
  assert.strictEqual(activePageForRole('Unknown'), 'analyst');
}

function testAllKnownRoleHomePaths() {
  assert.deepStrictEqual(['Admin', 'Analyst', 'Senior Analyst', 'STRO'].map(roleHomePath), [
    '/admin',
    '/analyst',
    '/senior-analyst',
    '/stro',
  ]);
}

function testAllKnownActivePages() {
  assert.deepStrictEqual(['Admin', 'Analyst', 'Senior Analyst', 'STRO'].map(activePageForRole), [
    'admin',
    'analyst',
    'senior-analyst',
    'stro',
  ]);
}

function testAuthRedirect() {
  let nextCalled = false;
  const publicResponse = mockResponse();
  authRedirect({ path: '/login', session: {} }, publicResponse, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(publicResponse.redirectPath, null);

  nextCalled = false;
  const apiResponse = mockResponse();
  authRedirect({ path: '/api/transactions', session: {} }, apiResponse, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);

  const protectedResponse = mockResponse();
  authRedirect({ path: '/analyst', session: {} }, protectedResponse, () => {});
  assert.strictEqual(protectedResponse.redirectPath, '/login');

  nextCalled = false;
  const signedInResponse = mockResponse();
  authRedirect({ path: '/analyst', session: { user: { role: 'Analyst' } } }, signedInResponse, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
}

function testAuthRedirectAllowsStaticImagePath() {
  let nextCalled = false;
  const response = mockResponse();
  authRedirect({ path: '/images/logo.png', session: {} }, response, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(response.redirectPath, null);
}

function testRequireRoleAndAuth() {
  const missingUserResponse = mockResponse();
  requireRole('Admin')({ session: {} }, missingUserResponse, () => {});
  assert.strictEqual(missingUserResponse.redirectPath, '/login');

  const forbiddenResponse = mockResponse();
  requireRole('Admin')({ session: { user: { role: 'Analyst' } } }, forbiddenResponse, () => {});
  assert.strictEqual(forbiddenResponse.statusCode, 403);
  assert.strictEqual(forbiddenResponse.sentBody, 'Forbidden');

  let nextCalled = false;
  requireRole('Admin')({ session: { user: { role: 'Admin' } } }, mockResponse(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);

  const authResponse = mockResponse();
  requireAuth({ session: {} }, authResponse, () => {});
  assert.strictEqual(authResponse.redirectPath, '/login');
}

function testRequireRoleAllowsAnyListedRole() {
  let nextCalled = false;
  requireRole('Analyst', 'Senior Analyst')(
    { session: { user: { role: 'Senior Analyst' } } },
    mockResponse(),
    () => { nextCalled = true; },
  );
  assert.strictEqual(nextCalled, true);
}

function testRequireAuthAllowsSignedInUser() {
  let nextCalled = false;
  requireAuth({ session: { user: { role: 'Analyst' } } }, mockResponse(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
}

function testJsonPermissions() {
  assert.strictEqual(roleCanPerform('Analyst', 'sendRfi'), true);
  assert.strictEqual(roleCanPerform('STRO', 'fileStr'), true);
  assert.strictEqual(roleCanPerform('Analyst', 'fileStr'), false);
  assert.strictEqual(roleCanPerform('Admin', 'manageRules'), true);
  assert.strictEqual(roleCanPerform('Admin', 'resolveCase'), false);
  assert.strictEqual(roleCanPerform('Analyst', 'unknownAction'), false);

  const response = mockResponse();
  forbidJson(response);
  assert.strictEqual(response.statusCode, 403);
  assert.deepStrictEqual(response.jsonBody, {
    success: false,
    message: 'You do not have permission to perform this action.',
  });
}

function testRolePermissionMatrix() {
  assert.strictEqual(roleCanPerform('Senior Analyst', 'escalateCase'), true);
  assert.strictEqual(roleCanPerform('Senior Analyst', 'resolveCase'), true);
  assert.strictEqual(roleCanPerform('STRO', 'resolveCase'), false);
  assert.strictEqual(roleCanPerform('Admin', 'sendRfi'), false);
}

async function main() {
  suite('Auth Middleware');
  await runTest('maps roles to home paths and active pages', testRoleMappings);
  await runTest('maps all known roles to home paths', testAllKnownRoleHomePaths);
  await runTest('maps all known roles to active pages', testAllKnownActivePages);
  await runTest('redirects unauthenticated users and allows public/API paths', testAuthRedirect);
  await runTest('allows public static image paths without login', testAuthRedirectAllowsStaticImagePath);
  await runTest('enforces required roles and login state', testRequireRoleAndAuth);
  await runTest('allows any role listed by requireRole', testRequireRoleAllowsAnyListedRole);
  await runTest('allows signed-in users through requireAuth', testRequireAuthAllowsSignedInUser);
  await runTest('checks JSON permissions and forbidden response format', testJsonPermissions);
  await runTest('checks role permission matrix', testRolePermissionMatrix);
  finish();
}

main();
