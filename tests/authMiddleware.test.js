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

async function main() {
  suite('Auth Middleware');
  await runTest('maps roles to home paths and active pages', testRoleMappings);
  await runTest('redirects unauthenticated users and allows public/API paths', testAuthRedirect);
  await runTest('enforces required roles and login state', testRequireRoleAndAuth);
  await runTest('checks JSON permissions and forbidden response format', testJsonPermissions);
  finish();
}

main();
