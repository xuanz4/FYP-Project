const assert = require('assert');
const {
  riskLevelFromScore,
  isOutsideOperatingHours,
  getTransactionHour,
  OPERATING_HOURS,
} = require('../src/riskEngine');
const app = require('../app');

const { addWorkingDays } = app.locals.assignmentHelpers;
const { validateStrTransition } = app.locals.strWorkflowHelpers;

function testRiskLevelBands() {
  assert.strictEqual(riskLevelFromScore(0), 'Low');
  assert.strictEqual(riskLevelFromScore(29), 'Low');
  assert.strictEqual(riskLevelFromScore(30), 'Medium');
  assert.strictEqual(riskLevelFromScore(49), 'Medium');
  assert.strictEqual(riskLevelFromScore(50), 'High');
  assert.strictEqual(riskLevelFromScore(69), 'High');
  assert.strictEqual(riskLevelFromScore(70), 'Critical');
  assert.strictEqual(riskLevelFromScore(100), 'Critical');
}

function testOperatingHours() {
  assert.strictEqual(getTransactionHour(new Date('2026-07-01T03:00:00')), 3);
  assert.strictEqual(isOutsideOperatingHours(3), true);
  assert.strictEqual(isOutsideOperatingHours(OPERATING_HOURS.openHour), false);
  assert.strictEqual(isOutsideOperatingHours(OPERATING_HOURS.closeHour - 1), false);
  assert.strictEqual(isOutsideOperatingHours(OPERATING_HOURS.closeHour), true);
}

function testAddWorkingDays() {
  // Monday 2026-07-06 + 2 working days should land on Wednesday, skipping no weekend.
  const monday = new Date('2026-07-06T00:00:00');
  const result = addWorkingDays(monday, 2);
  assert.strictEqual(result.getDay(), 3);

  // Friday + 1 working day should skip the weekend and land on Monday.
  const friday = new Date('2026-07-10T00:00:00');
  const afterWeekend = addWorkingDays(friday, 1);
  assert.strictEqual(afterWeekend.getDay(), 1);
}

function testStrTransitions() {
  assert.strictEqual(validateStrTransition('Recommended', 'Filed'), true);
  assert.strictEqual(validateStrTransition('Recommended', 'Draft'), false);
  assert.strictEqual(validateStrTransition('Filed', 'Recommended'), false);
}

testRiskLevelBands();
testOperatingHours();
testAddWorkingDays();
testStrTransitions();

console.log('Risk engine tests passed');
