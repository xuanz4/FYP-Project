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
  assert.doesNotMatch(view, /id="rfiPreviewButton"|previewButton\?\.addEventListener/);
  assert.match(view, /form\?\.addEventListener\('submit'/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(openButton\?\.dataset\.transactionId \|\| ''\)\}\/rfi`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(resolveOpenButton\?\.dataset\.transactionId \|\| '<%= transactionId %>'\)\}\/resolve`/);
  assert.match(view, /fetch\(`\/api\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assign-to-me`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/escalate`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/refer-to-stro`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/str`/);
  assert.match(view, /fetch\(`\/api\/transactions\/\$\{encodeURIComponent\(<%- JSON\.stringify\(transactionId\) %>\)\}\/str\/not-required`/);
  assert.match(view, /rfi\/latest-response\?source=\$\{source\}/);
  assert.match(view, /setInterval\(\(\) => \{/);
  assert.match(view, /}, 8000\)/);
  assert.match(view, /if \(!document\.hidden\) checkForRfiResponse\(\)/);
  assert.match(view, /const isTerminalCase = isResolved \|\| \['Filed', 'Not Required'\]\.includes\(strStatus\)/);
  assert.match(view, /const seniorReviewStage = isSenior && !!caseInfo && routedToSenior && !routedToStro/);
  assert.match(view, /data-transaction-notification-slot/);
  assert.match(view, /slot\.append\(notifications\)/);
  assert.match(view, /const hasFinalAssessment = finalScore !== null \|\| isTerminalCase/);
  assert.match(view, /hasFinalAssessment \? 'Decision' : 'Latest action'/);
  assert.match(view, /hasFinalAssessment \? 'Resolved by' : 'Actioned by'/);
}

function testApiRoutesExist() {
  const routes = readView('routes/transactions.js');
  assert.match(routes, /router\.get\('\/transactions\/:id'/);
  assert.match(routes, /router\.patch\('\/api\/cases\/:caseId\/assign-to-me'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/rfi'/);
  assert.match(routes, /router\.get\('\/api\/transactions\/:id\/rfi\/latest-response'/);
  assert.match(routes, /router\.patch\('\/api\/transactions\/:id\/resolve'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/escalate'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/refer-to-stro'/);
  assert.match(routes, /router\.patch\('\/api\/transactions\/:id\/str'/);
  assert.match(routes, /router\.post\('\/api\/transactions\/:id\/str\/not-required'/);
  assert.match(routes, /transactionsController\.authorizeCaseDocumentUpload,\s*uploadCddDocument/);
  // The manual CDD checklist endpoint was removed - CDD items are only ever completed as a
  // side effect of a validated document upload, never through a standalone form/route.
  assert.doesNotMatch(routes, /\/api\/transactions\/:id\/cdd-checklist/);
}

// CDD/EDD checklist completion is driven entirely by document uploads (see
// transactionsController.js's uploadCaseDocument). The only checklist item still submitted
// through a standalone form is Senior Sign-off, since it's an approval with no document type
// of its own. This locks in that the manual "Update checklist" forms and their duplicate
// notes fields don't come back.
function testChecklistFormsAreUploadDrivenExceptSignoff() {
  const view = readView('views/transaction-detail.ejs');
  const controller = readView('controllers/transactionsController.js');
  assert.doesNotMatch(view, /id="cddChecklistForm"/);
  assert.doesNotMatch(view, /id="eddAnalystForm"/);
  assert.doesNotMatch(view, /id="eddEnhancedVerificationForm"/);
  assert.match(view, /id="eddSignoffForm"/);
  assert.match(view, /id="cddDocumentForm"/);
  assert.match(view, /: \(isAnalyst\s*\?\s*\[/);
  assert.match(view, /!cddChecklist\.business_registration_verified \? 'Business Registration' : null/);
  assert.match(view, /!eddChecklist\.source_of_funds_verified \? 'Source of Funds' : null/);
  assert.match(view, /&& !eddChecklist\.senior_signoff_completed\s*&& !isTerminalCase/);
  assert.match(controller, /Senior Sign-off has already been completed and cannot be changed/);
  assert.match(controller, /Senior Sign-off is a one-time approval/);
  assert.match(controller, /CDD is already complete; no additional CDD document is required/);
  assert.match(controller, /Documents cannot be uploaded after the case is closed/);
  assert.match(controller, /transactionRiskLevel: transactionCase\.risk_level/);
}

function testCddPanelStaysOpenAfterDocumentUpload() {
  const uploadScript = readView('public/cdd-upload.js');
  const transactionDetail = readView('views/transaction-detail.ejs');

  assert.match(uploadScript, /sessionStorage\.setItem\(`merchantCddExpanded:/);
  assert.match(transactionDetail, /sessionStorage\.getItem\(cddExpandedStorageKey\) === 'true'/);
  assert.match(transactionDetail, /setCddExpanded\(true\)/);
}

async function main() {
  suite('Website View Contracts');
  await runTest('keeps login form fields and auth route intact', testLoginFormContract);
  await runTest('renders role-specific sidebar navigation', testSidebarRoleNavigation);
  await runTest('keeps transaction detail workflow controls wired to APIs', testTransactionDetailWorkflowControls);
  await runTest('defines expected transaction API routes', testApiRoutesExist);
  await runTest('checklist completion is upload-driven except Senior Sign-off', testChecklistFormsAreUploadDrivenExceptSignoff);
  await runTest('keeps merchant due diligence expanded after document upload', testCddPanelStaysOpenAfterDocumentUpload);
  finish();
}

main();
