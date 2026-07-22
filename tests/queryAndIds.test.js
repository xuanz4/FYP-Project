const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { id } = require('../src/lib/ids');

function testPaginationDefaultsAndBounds() {
  assert.deepStrictEqual(paginationMeta({ query: {} }, 40), {
    page: 1,
    limit: 15,
    total: 40,
    totalPages: 3,
    offset: 0,
  });

  assert.deepStrictEqual(paginationMeta({ query: { page: '2', limit: '100' } }, 80), {
    page: 2,
    limit: 25,
    total: 80,
    totalPages: 4,
    offset: 25,
  });

  assert.deepStrictEqual(paginationMeta({ query: { page: '-1', limit: 'bad' } }, 0, 20), {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
    offset: 0,
  });
}

function testPaginationUsesFallbackLimit() {
  assert.deepStrictEqual(paginationMeta({ query: { page: '3' } }, 31, 10), {
    page: 3,
    limit: 10,
    total: 31,
    totalPages: 4,
    offset: 20,
  });
}

function testPaginationRejectsDecimalPageAndLimit() {
  assert.deepStrictEqual(paginationMeta({ query: { page: '2.5', limit: '7.5' } }, 12, 8), {
    page: 1,
    limit: 8,
    total: 12,
    totalPages: 2,
    offset: 0,
  });
}

function testAppendWhereSkipsEmptyValues() {
  const where = [];
  const values = [];
  appendWhere(where, values, 'risk_level = ?', 'High');
  appendWhere(where, values, 'status = ?', '');
  appendWhere(where, values, 'assigned_to = ?', null);
  appendWhere(where, values, 'merchant_id = ?', 'M001');

  assert.deepStrictEqual(where, ['risk_level = ?', 'merchant_id = ?']);
  assert.deepStrictEqual(values, ['High', 'M001']);
}

function testAppendWhereKeepsZeroAndFalseValues() {
  const where = [];
  const values = [];
  appendWhere(where, values, 'risk_score = ?', 0);
  appendWhere(where, values, 'is_active = ?', false);

  assert.deepStrictEqual(where, ['risk_score = ?', 'is_active = ?']);
  assert.deepStrictEqual(values, [0, false]);
}

function testAppendWherePreservesClauseOrder() {
  const where = [];
  const values = [];
  appendWhere(where, values, 'merchant_id = ?', 'M001');
  appendWhere(where, values, 'risk_level = ?', 'High');
  appendWhere(where, values, 'status = ?', 'Flagged');

  assert.deepStrictEqual(where, ['merchant_id = ?', 'risk_level = ?', 'status = ?']);
  assert.deepStrictEqual(values, ['M001', 'High', 'Flagged']);
}

function testIdFormatUsesPrefix() {
  const generated = id('AUD');
  assert.match(generated, /^AUD-[0-9A-Z]+-[0-9A-Z]{5}$/);
}

function testIdSupportsDifferentPrefixes() {
  assert.match(id('CASE'), /^CASE-[0-9A-Z]+-[0-9A-Z]{5}$/);
  assert.match(id('STR'), /^STR-[0-9A-Z]+-[0-9A-Z]{5}$/);
}

function testIdGeneratesDifferentValues() {
  const generated = new Set(Array.from({ length: 5 }, () => id('AUD')));
  assert.strictEqual(generated.size, 5);
}

async function main() {
  suite('Query and ID Helpers');
  await runTest('builds pagination metadata with defaults and bounds', testPaginationDefaultsAndBounds);
  await runTest('uses fallback pagination limit when no limit is supplied', testPaginationUsesFallbackLimit);
  await runTest('rejects decimal pagination values', testPaginationRejectsDecimalPageAndLimit);
  await runTest('appends WHERE clauses only for non-empty values', testAppendWhereSkipsEmptyValues);
  await runTest('keeps zero and false WHERE values', testAppendWhereKeepsZeroAndFalseValues);
  await runTest('preserves WHERE clause order', testAppendWherePreservesClauseOrder);
  await runTest('generates IDs with the requested prefix', testIdFormatUsesPrefix);
  await runTest('generates IDs for different prefixes', testIdSupportsDifferentPrefixes);
  await runTest('generates different ID values across calls', testIdGeneratesDifferentValues);
  finish();
}

main();
