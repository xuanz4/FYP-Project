const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { analystFiltersFromQuery, seniorFiltersFromQuery } = require('../src/lib/caseFilters');

function testAnalystFiltersTrimInputs() {
  assert.deepStrictEqual(analystFiltersFromQuery({
    riskLevel: ' High ',
    transactionStatus: ' Flagged ',
    merchantId: ' M001 ',
    assessmentStatus: ' Under Review ',
    assignedTo: ' U001 ',
    assignedRole: ' Analyst ',
    escalatedTo: ' STRO ',
    decision: ' Accepted ',
    dueStatus: ' Overdue ',
    q: ' txn ',
    sort: ' newest ',
  }), {
    riskLevel: 'High',
    transactionStatus: 'Flagged',
    merchantId: 'M001',
    assessmentStatus: 'Under Review',
    assignedTo: 'U001',
    assignedRole: 'Analyst',
    escalatedTo: 'STRO',
    decision: 'Accepted',
    dueStatus: 'Overdue',
    q: 'txn',
    sort: 'newest',
  });
}

function testAnalystFiltersDefaultToEmptyStrings() {
  const filters = analystFiltersFromQuery({});
  assert.strictEqual(Object.values(filters).every((value) => value === ''), true);
}

function testAnalystFiltersStringifyNonStringInputs() {
  const filters = analystFiltersFromQuery({
    riskLevel: 123,
    merchantId: false,
    q: null,
  });
  assert.strictEqual(filters.riskLevel, '123');
  assert.strictEqual(filters.merchantId, '');
  assert.strictEqual(filters.q, '');
}

function testSeniorFiltersIncludeAuditAndScopeFields() {
  const filters = seniorFiltersFromQuery({
    riskLevel: 'Critical',
    assignmentStatus: ' Unassigned ',
    referralStatus: ' Recommended ',
    actionType: ' STR Filed ',
    userId: ' U004 ',
    userRole: ' STRO ',
    dateFrom: ' 2026-07-01 ',
    dateTo: ' 2026-07-21 ',
    scope: ' team ',
  });

  assert.strictEqual(filters.riskLevel, 'Critical');
  assert.strictEqual(filters.assignmentStatus, 'Unassigned');
  assert.strictEqual(filters.referralStatus, 'Recommended');
  assert.strictEqual(filters.actionType, 'STR Filed');
  assert.strictEqual(filters.userId, 'U004');
  assert.strictEqual(filters.userRole, 'STRO');
  assert.strictEqual(filters.dateFrom, '2026-07-01');
  assert.strictEqual(filters.dateTo, '2026-07-21');
  assert.strictEqual(filters.scope, 'team');
}

function testSeniorFiltersDefaultExtraFieldsToEmptyStrings() {
  const filters = seniorFiltersFromQuery({});
  assert.strictEqual(filters.assignmentStatus, '');
  assert.strictEqual(filters.referralStatus, '');
  assert.strictEqual(filters.actionType, '');
  assert.strictEqual(filters.userId, '');
  assert.strictEqual(filters.userRole, '');
  assert.strictEqual(filters.dateFrom, '');
  assert.strictEqual(filters.dateTo, '');
  assert.strictEqual(filters.scope, '');
}

function testSeniorFiltersKeepAnalystFilterFields() {
  const filters = seniorFiltersFromQuery({
    transactionStatus: ' Flagged ',
    assignedRole: ' STRO ',
    q: ' reference ',
  });
  assert.strictEqual(filters.transactionStatus, 'Flagged');
  assert.strictEqual(filters.assignedRole, 'STRO');
  assert.strictEqual(filters.q, 'reference');
}

async function main() {
  suite('Case Filters');
  await runTest('trims analyst filter inputs', testAnalystFiltersTrimInputs);
  await runTest('defaults missing analyst filters to empty strings', testAnalystFiltersDefaultToEmptyStrings);
  await runTest('stringifies analyst filter values safely', testAnalystFiltersStringifyNonStringInputs);
  await runTest('includes senior audit and scope filter fields', testSeniorFiltersIncludeAuditAndScopeFields);
  await runTest('defaults missing senior filter fields to empty strings', testSeniorFiltersDefaultExtraFieldsToEmptyStrings);
  await runTest('keeps analyst filter fields on senior filters', testSeniorFiltersKeepAnalystFilterFields);
  finish();
}

main();
