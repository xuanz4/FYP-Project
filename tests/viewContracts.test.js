const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite, runTest, finish } = require('./runAll');

const root = path.join(__dirname, '..');

function readView(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function testLoginFormContract() {
  const view = readView('views/login.ejs');
  assert.match(view, /method="post"\s+action="\/auth\/login"/);
  assert.match(view, /name="userId"/);
  assert.match(view, /autocomplete="username"/);
  assert.match(view, /name="password"/);
  assert.match(view, /autocomplete="current-password"/);
  assert.match(view, /<% if \(error\) \{ %>/);
}

function testSidebarRoleNavigation() {
  const view = readView('views/partials/sidebar.ejs');
  assert.match(view, /currentRole==='Admin'/);
  assert.match(view, /href="\/admin\/users"/);
  assert.match(view, /currentRole==='Analyst'/);
  assert.match(view, /href="\/analyst\/working-queue"/);
  assert.match(view, /currentRole==='Senior Analyst'/);
  assert.match(view, /href="\/senior-analyst\/cases"/);
  assert.match(view, /currentRole==='STRO'/);
  assert.match(view, /href="\/stro\/str-reports"/);
  assert.match(view, /href="\/logout"/);
}

function testTransactionDetailWorkflowControls() {
  const view = readView('views/transaction-detail.ejs');
  assert.match(view, /id="assignToMeButton"/);
  assert.match(view, /id="rfiEmailModal"/);
  assert.match(view, /previewButton\?\.addEventListener\('click'/);
  assert.match(view, /form\?\.addEventListener\('submit'/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(openButton\?\.dataset\.transactionId \|\| ''\)\}\/rfi`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(resolveOpenButton\?\.dataset\.transactionId \|\| '<%= transactionId %>'\)\}\/resolve`/);
  assert.match(view, /fetch\(`\/api\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assign-to-me`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/escalate`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/refer-to-stro`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/str`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/str\/not-required`/);
}

function testApiRoutesExist() {
  const routes = readView('routes/transactions.js');
  assert.match(routes, /router\.get\('\/transactions\/:id'/);
  assert.match(routes, /router\.patch\('\/api\/cases\/:caseId\/assign-to-me'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/rfi'/);
  assert.match(routes, /router\.patch\('\/api\/transactions\/:id\/resolve'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/escalate'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/refer-to-stro'/);
  assert.match(routes, /router\.patch\('\/api\/transactions\/:id\/str'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/str\/not-required'/);
}

async function main() {
  suite('Website View Contracts');
  await runTest('keeps login form fields and auth route intact', testLoginFormContract);
  await runTest('renders role-specific sidebar navigation', testSidebarRoleNavigation);
  await runTest('keeps transaction detail workflow controls wired to APIs', testTransactionDetailWorkflowControls);
  await runTest('defines expected transaction API routes', testApiRoutesExist);
  finish();
}

main();
