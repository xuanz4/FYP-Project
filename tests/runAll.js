const { spawnSync } = require('child_process');
const path = require('path');

const results = [];
let currentSuite = null;

const PASS_MARK = '\u2713';
const FAIL_MARK = '\u2717';

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
};

const testFiles = [
  'riskEngine.test.js',
  'riskEvaluation.test.js',
  'rfiWorkflow.test.js',
  'rfiInboxService.test.js',
  'authMiddleware.test.js',
  'strDraft.test.js',
  'caseFilters.test.js',
  'queryAndIds.test.js',
  'transactionIngestion.test.js',
  'merchantRiskProfile.test.js',
  'merchantCdd.test.js',
  'cddDocuments.test.js',
  'uploadValidation.test.js',
  'resolveWorkflow.test.js',
  'checklistAutoComplete.test.js',
  'viewContracts.test.js',
];

function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

async function runTest(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - startedAt;
    results.push({
      suite: currentSuite,
      name,
      passed: true,
      durationMs,
    });
    console.log(`  ${colors.green}${PASS_MARK}${colors.reset} ${colors.gray}${name}${colors.reset} ${colors.red}(${durationMs}ms)${colors.reset}`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    results.push({
      suite: currentSuite,
      name,
      passed: false,
      durationMs,
      error,
    });
    console.error(`  ${colors.red}${FAIL_MARK} ${name} (${durationMs}ms)${colors.reset}`);
    console.error(error);
  }
}

function finish() {
  if (process.env.TEST_RUNNER_HIDE_SUMMARY === '1') {
    return;
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));

  if (failed > 0) {
    console.log(`\n${colors.red}${failed} failing${colors.reset}`);
  }
  console.log(`\n${colors.green}${passed} passing${colors.reset} ${colors.gray}(${totalSeconds}s)${colors.reset}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function runAll() {
  const startedAt = Date.now();
  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        TEST_RUNNER_HIDE_SUMMARY: '1',
      },
      encoding: 'utf8',
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    process.stdout.write(output);

    const plainOutput = stripAnsi(output);
    passed += (plainOutput.match(new RegExp(`^  ${PASS_MARK} `, 'gm')) || []).length;
    failed += (plainOutput.match(new RegExp(`^  ${FAIL_MARK} `, 'gm')) || []).length;

    if (result.status !== 0 && !plainOutput.match(new RegExp(`^  ${FAIL_MARK} `, 'm'))) {
      failed += 1;
    }
  }

  const totalSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

  if (failed > 0) {
    console.log(`\n${colors.red}${failed} failing${colors.reset}`);
  }
  console.log(`\n${colors.green}${passed} passing${colors.reset} ${colors.gray}(${totalSeconds}s)${colors.reset}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runAll();
}

module.exports = {
  suite,
  runTest,
  finish,
  runAll,
};
