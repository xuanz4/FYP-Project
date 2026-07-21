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

function testIdFormatUsesPrefix() {
  const generated = id('AUD');
  assert.match(generated, /^AUD-[0-9A-Z]+-[0-9A-Z]{5}$/);
}

async function main() {
  suite('Query and ID Helpers');
  await runTest('builds pagination metadata with defaults and bounds', testPaginationDefaultsAndBounds);
  await runTest('appends WHERE clauses only for non-empty values', testAppendWhereSkipsEmptyValues);
  await runTest('generates IDs with the requested prefix', testIdFormatUsesPrefix);
  finish();
}

main();
