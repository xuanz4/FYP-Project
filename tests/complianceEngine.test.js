const assert = require('assert');
const {
  calculateProfileRiskScore,
  evaluateTransaction,
  riskBands,
  riskLevelToPoints,
  companyRuleSets,
  serializeCompanyRuleSets,
} = require('../src/complianceEngine');
const { buildAnalytics } = require('../src/analyticsEngine');
const { buildCustomerRiskProfiles } = require('../src/customerRiskEngine');
const { screenPayment } = require('../src/screeningEngine');
const { buildRfiEmail } = require('../src/services/emailService');
const app = require('../app');

const highRiskTransaction = {
  amount: 50000,
  country: 'Singapore',
  counterpartyCountry: 'Iran',
  merchantCategory: 'High-Value Retail',
  cardSpend24h: 52000,
  kycStatus: 'Pending Review',
  direction: 'Sale',
};

const lowRiskTransaction = {
  amount: 120,
  country: 'Singapore',
  merchantCategory: 'Retail Goods',
  cardSpend24h: 120,
  kycStatus: 'Verified',
  direction: 'Sale',
};

const highRiskResult = evaluateTransaction(highRiskTransaction);
const lowRiskResult = evaluateTransaction(lowRiskTransaction);
const localTimestampAtHour = (hour) => new Date(2026, 0, 1, hour, 0, 0).toISOString();
const afternoonOperatingHoursResult = evaluateTransaction({ ...lowRiskTransaction, createdAt: localTimestampAtHour(14) });
const overnightOperatingHoursResult = evaluateTransaction({ ...lowRiskTransaction, createdAt: localTimestampAtHour(2) });
const industryRiskResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 12 });
const mediumActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 30 });
const highActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 50 });
const criticalActionResult = evaluateTransaction({ ...lowRiskTransaction, industryRiskScore: 70 });
const profileRiskResult = evaluateTransaction({
  ...lowRiskTransaction,
  customerRiskLevel: 'HIGH',
  merchantRiskLevel: 'MEDIUM',
});
const highProfileRiskResult = evaluateTransaction({
  ...lowRiskTransaction,
  customerRiskLevel: 'HIGH',
  merchantRiskLevel: 'HIGH',
});

assert.strictEqual(highRiskResult.transactionDetectionScore, 115);
assert.strictEqual(highRiskResult.initialRiskScore, 115);
assert.strictEqual(highRiskResult.riskScore, 115);
assert.strictEqual(riskBands(highRiskResult.riskScore), 'Critical');
assert.strictEqual(highRiskResult.matchedRules.length, 4);
assert.strictEqual(Object.hasOwn(highRiskResult, 'finalRiskScore'), false);
assert.strictEqual(Object.hasOwn(highRiskResult, 'finalRiskLevel'), false);

assert.strictEqual(lowRiskResult.riskScore, 0);
assert.strictEqual(lowRiskResult.mccRiskScore, 0);
assert.strictEqual(lowRiskResult.profileRiskScore, 0);
assert.strictEqual(lowRiskResult.transactionDetectionScore, 0);
assert.strictEqual(lowRiskResult.initialRiskScore, 0);
assert.strictEqual(riskBands(lowRiskResult.riskScore), 'Low');
assert.strictEqual(lowRiskResult.matchedRules.length, 0);
assert.strictEqual(lowRiskResult.recommendedAction, 'Allow');

assert.strictEqual(afternoonOperatingHoursResult.transactionHour, 14);
assert.strictEqual(afternoonOperatingHoursResult.operatingHoursTriggered, false);
assert.strictEqual(afternoonOperatingHoursResult.transactionDetectionScore, 0);
assert.ok(!afternoonOperatingHoursResult.triggeredRules.some((rule) => rule.id === 'TIME-001'));
assert.strictEqual(overnightOperatingHoursResult.transactionHour, 2);
assert.strictEqual(overnightOperatingHoursResult.operatingHoursTriggered, true);
assert.strictEqual(overnightOperatingHoursResult.transactionDetectionScore, 10);
assert.strictEqual(overnightOperatingHoursResult.initialRiskScore, 10);
assert.ok(overnightOperatingHoursResult.triggeredRules.some((rule) => rule.id === 'TIME-001'));

assert.strictEqual(mediumActionResult.initialRiskLevel, 'Medium');
assert.strictEqual(mediumActionResult.recommendedAction, 'Monitor');
assert.strictEqual(highActionResult.initialRiskLevel, 'High');
assert.strictEqual(highActionResult.recommendedAction, 'Request OTP');
assert.strictEqual(criticalActionResult.initialRiskLevel, 'Critical');
assert.strictEqual(criticalActionResult.recommendedAction, 'Manual Review or Hold Settlement');

assert.strictEqual(industryRiskResult.riskScore, 12);
assert.strictEqual(industryRiskResult.mccRiskScore, 12);
assert.strictEqual(industryRiskResult.matchedRules.length, 0);
assert.strictEqual(companyRuleSets.companyA.mccCode, '5651');
assert.strictEqual(serializeCompanyRuleSets()[0].industryRiskScore, 8);

assert.strictEqual(riskLevelToPoints('LOW'), 0);
assert.strictEqual(riskLevelToPoints('MEDIUM'), 15);
assert.strictEqual(riskLevelToPoints('HIGH'), 30);
assert.strictEqual(calculateProfileRiskScore({ customerRiskLevel: 'HIGH', merchantRiskLevel: 'MEDIUM' }), 45);
assert.strictEqual(profileRiskResult.profileRiskScore, 45);
assert.strictEqual(profileRiskResult.riskScore, 45);
assert.strictEqual(profileRiskResult.initialRiskLevel, 'Medium');
assert.strictEqual(highProfileRiskResult.profileRiskScore, 60);
assert.strictEqual(highProfileRiskResult.initialRiskLevel, 'High');
assert.strictEqual(highProfileRiskResult.recommendedAction, 'Request OTP');
assert.ok(highProfileRiskResult.matchedRules.some((rule) => rule.id === 'PROFILE-CUSTOMER-HIGH'));
assert.ok(highProfileRiskResult.matchedRules.some((rule) => rule.id === 'PROFILE-MERCHANT-HIGH'));

const analytics = buildAnalytics(
  [
    {
      status: 'Flagged',
      riskBand: 'High',
      riskScore: 55,
      amount: 1500,
      country: 'Singapore',
      counterpartyCountry: 'Iran',
      companyName: 'Merchant Profile 5651',
      customerName: 'Ava Lim',
      matchedRules: [{ name: 'Contextual jurisdiction escalation', weight: 20 }],
    },
    {
      status: 'Cleared',
      riskBand: 'Low',
      riskScore: 0,
      amount: 120,
      country: 'Singapore',
      companyName: 'Merchant Profile 5651',
      customerName: 'Noah Tan',
      matchedRules: [],
    },
  ],
  [{ status: 'Escalated' }],
  [{ dueAt: new Date(Date.now() - 60 * 1000).toISOString() }],
);

assert.strictEqual(analytics.summary.flagRate, 50);
assert.strictEqual(analytics.summary.highRiskRate, 50);
assert.strictEqual(analytics.summary.escalatedAlerts, 1);
assert.strictEqual(analytics.summary.overdueCases, 1);
assert.strictEqual(analytics.drivers[0].label, 'Contextual jurisdiction escalation');

const screening = screenPayment({
  customerName: 'Ava Lim',
  counterpartyName: 'Orion Trade Holdings',
  counterpartyCountry: 'Iran',
  paymentReference: 'Card payment linked to Orion Trade Holdings',
});

assert.strictEqual(screening.status, 'Potential Match');
assert.strictEqual(screening.matches[0].type, 'Sanctions');

const customerProfiles = buildCustomerRiskProfiles(
  [
    {
      customerId: 'CUS-1003',
      customerName: 'Maya Wong',
      segment: 'Private Client',
      kycStatus: 'Enhanced Due Diligence',
      customerRiskLevel: 'HIGH',
      merchantRiskLevel: 'MEDIUM',
      country: 'Singapore',
      companyId: 'companyA',
      companyName: 'Merchant Profile 5651',
      status: 'Flagged',
      riskScore: 70,
      amount: 3000,
      screeningMatches: [],
    },
  ],
  [{ customerId: 'CUS-1003', status: 'New' }],
);

assert.strictEqual(customerProfiles[0].screeningStatus, 'Potential Match');
assert.ok(customerProfiles[0].riskScore >= 50);

async function assertNewTransactionStoresInitialRisk() {
  const suiteOriginalEmailProvider = process.env.EMAIL_PROVIDER;
  const suiteOriginalTestMode = process.env.EMAIL_TEST_MODE;
  process.env.EMAIL_PROVIDER = 'smtp';
  delete process.env.EMAIL_TEST_MODE;
  const sentRfiEmails = [];
  let failNextRfiEmail = false;
  app.locals.emailService = {
    sendRfiEmail: async (options) => {
      if (failNextRfiEmail) {
        if (failNextRfiEmail === 'EAUTH') {
          failNextRfiEmail = false;
          const error = new Error('Invalid login');
          error.code = 'EAUTH';
          throw error;
        }
        failNextRfiEmail = false;
        throw new Error('Mock email failure');
      }
      const etherealMode = process.env.EMAIL_PROVIDER === 'ethereal';
      const testMode = process.env.EMAIL_TEST_MODE === 'true' || etherealMode;
      const deliveredTo = options.to;
      const deliveredSubject = testMode ? `[TEST] ${options.subject}` : options.subject;
      sentRfiEmails.push({ ...options, deliveredTo, deliveredSubject, testMode, etherealMode });
      return {
        testMode,
        etherealMode,
        previewUrl: etherealMode ? 'https://ethereal.email/message/mock-preview' : null,
        delivery: {
          accepted: [deliveredTo.replace(/^(.{2}).*(@.*)$/, '$1***$2')],
          rejected: [],
          pending: [],
          response: '250 Accepted',
          messageId: `mock-${sentRfiEmails.length}`,
        },
        info: { messageId: `mock-${sentRfiEmails.length}` },
      };
    },
  };

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const createTransaction = async (suffix = 'Initial', overrides = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: `${suffix} Risk Test`,
          customerId: `CUS-TEST-${suffix}-${Date.now()}`,
          customerEmail: `${suffix.toLowerCase()}-${Date.now()}@example.com`,
          amount: 1300,
          country: 'Singapore',
          merchantCategory: 'Premium Bundle',
          channel: 'Bank Transfer',
          direction: 'Outbound',
          companyId: 'companyA',
          ...overrides,
        }),
      });
      assert.strictEqual(response.status, 201);
      return response.json();
    };

    const resolveTransaction = async (transaction, overrides = {}) => fetch(`http://127.0.0.1:${port}/api/transactions/${encodeURIComponent(transaction.id)}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        finalRiskLevel: 'Medium',
        decision: 'Accepted',
        resolutionReason: 'Legitimate Transaction',
        analystNotes: 'Reviewed supporting context and accepted the transaction.',
        ...overrides,
      }),
    });

    const postAction = async (transaction, overrides = {}) => fetch(`http://127.0.0.1:${port}/api/transactions/${encodeURIComponent(transaction.id)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'RFI_REQUESTED',
        notes: 'Please provide supporting documents for assessment review.',
        ...overrides,
      }),
    });

    const postRfi = async (transaction, overrides = {}) => fetch(`http://127.0.0.1:${port}/api/transactions/${encodeURIComponent(transaction.id)}/rfi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: 'Additional Information Required for Your Transaction',
        informationRequested: 'Please provide the invoice and source-of-funds documents.',
        ...overrides,
      }),
    });

    const getActivity = async (transaction) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/transactions/${encodeURIComponent(transaction.id)}/activity`);
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      return body.activityLogs;
    };

    const transaction = await createTransaction('Initial');
    assert.strictEqual(transaction.initialRiskScore, transaction.riskScore);
    assert.strictEqual(transaction.initialRiskLevel, transaction.riskBand);
    assert.strictEqual(transaction.finalRiskScore, null);
    assert.strictEqual(transaction.finalRiskLevel, null);

    const scoreCases = [
      ['Low', 15],
      ['Medium', 40],
      ['High', 60],
      ['Critical', 80],
    ];

    for (const [level, expectedScore] of scoreCases) {
      const riskTransaction = await createTransaction(level);
      const initialRiskScore = riskTransaction.initialRiskScore;
      const initialRiskLevel = riskTransaction.initialRiskLevel;
      const response = await resolveTransaction(riskTransaction, { finalRiskLevel: level });
      const body = await response.json();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.transaction.initialRiskScore, initialRiskScore);
      assert.strictEqual(body.transaction.initialRiskLevel, initialRiskLevel);
      assert.strictEqual(body.transaction.finalRiskScore, expectedScore);
      assert.strictEqual(body.transaction.finalRiskLevel, level);
      assert.strictEqual(body.transaction.decision, 'Accepted');
      assert.strictEqual(body.transaction.resolutionReason, 'Legitimate Transaction');
      assert.strictEqual(body.transaction.analystNotes, 'Reviewed supporting context and accepted the transaction.');
      assert.ok(body.transaction.resolvedAt);
      assert.strictEqual(body.case.status, 'Resolved');
    }

    const invalidLevelTransaction = await createTransaction('InvalidLevel');
    const invalidLevelResponse = await resolveTransaction(invalidLevelTransaction, { finalRiskLevel: 'Very High' });
    assert.strictEqual(invalidLevelResponse.status, 400);

    const emptyNotesTransaction = await createTransaction('EmptyNotes');
    const emptyNotesResponse = await resolveTransaction(emptyNotesTransaction, { analystNotes: '   ' });
    assert.strictEqual(emptyNotesResponse.status, 400);

    const duplicateTransaction = await createTransaction('Duplicate');
    const firstResolve = await resolveTransaction(duplicateTransaction, { finalRiskLevel: 'Low' });
    assert.strictEqual(firstResolve.status, 200);
    const duplicateResolve = await resolveTransaction(duplicateTransaction, { finalRiskLevel: 'Critical' });
    assert.strictEqual(duplicateResolve.status, 409);

    const rfiEmailTransaction = await createTransaction('RfiEmail');
    const sentBeforeRfi = sentRfiEmails.length;
    const validRfiResponse = await postRfi(rfiEmailTransaction);
    const validRfiBody = await validRfiResponse.json();
    assert.strictEqual(validRfiResponse.status, 200);
    assert.strictEqual(sentRfiEmails.length, sentBeforeRfi + 1);
    assert.strictEqual(sentRfiEmails.at(-1).to, rfiEmailTransaction.customerEmail);
    assert.strictEqual(sentRfiEmails.at(-1).recipientName, rfiEmailTransaction.customerName);
    assert.strictEqual(validRfiBody.transaction.assessmentStatus, 'Waiting for Information');
    assert.strictEqual(validRfiBody.auditEntry.action, 'Request for Information Sent');

    const previewSendCount = sentRfiEmails.length;
    const previewBody = buildRfiEmail({
      recipientName: rfiEmailTransaction.customerName,
      companyName: rfiEmailTransaction.companyName,
      transactionId: rfiEmailTransaction.id,
      transactionDate: new Date(rfiEmailTransaction.createdAt).toLocaleString('en-SG'),
      currency: rfiEmailTransaction.currency,
      amount: rfiEmailTransaction.amount,
      informationRequested: 'Please provide the invoice and source-of-funds documents.',
    });
    assert.ok(previewBody.includes('Please reply to this email with the requested information.'));
    assert.strictEqual(sentRfiEmails.length, previewSendCount);

    const repeatedRfiResponse = await postRfi(rfiEmailTransaction);
    assert.strictEqual(repeatedRfiResponse.status, 409);
    assert.strictEqual(sentRfiEmails.length, sentBeforeRfi + 1);

    const missingEmailTransaction = await createTransaction('MissingEmail', { customerEmail: '' });
    const missingEmailResponse = await postRfi(missingEmailTransaction);
    assert.strictEqual(missingEmailResponse.status, 400);

    const organisationTransaction = await createTransaction('OrgRfi', {
      accountType: 'Organisation',
      customerName: 'Acme Imports Pte Ltd',
      customerEmail: '',
      authorisedContactName: 'Priya Nair',
      authorisedContactEmail: 'priya.nair@example.com',
    });
    const organisationRfiResponse = await postRfi(organisationTransaction);
    assert.strictEqual(organisationRfiResponse.status, 200);
    assert.strictEqual(sentRfiEmails.at(-1).to, 'priya.nair@example.com');
    assert.strictEqual(sentRfiEmails.at(-1).recipientName, 'Priya Nair');

    const shortRfiTransaction = await createTransaction('ShortRfi');
    const shortRfiResponse = await postRfi(shortRfiTransaction, { informationRequested: 'hi' });
    assert.strictEqual(shortRfiResponse.status, 400);

    const restrictedRfiTransaction = await createTransaction('RestrictedRfi');
    const restrictedRfiResponse = await postRfi(restrictedRfiTransaction, {
      informationRequested: 'Please explain this suspicious transaction.',
    });
    assert.strictEqual(restrictedRfiResponse.status, 400);

    const failedRfiTransaction = await createTransaction('FailedRfi');
    const sentBeforeFailure = sentRfiEmails.length;
    failNextRfiEmail = true;
    const failedRfiResponse = await postRfi(failedRfiTransaction);
    assert.strictEqual(failedRfiResponse.status, 502);
    assert.strictEqual(sentRfiEmails.length, sentBeforeFailure);
    const failedRfiActivity = await getActivity(failedRfiTransaction);
    assert.ok(!failedRfiActivity.some((entry) => entry.action === 'Request for Information Sent'));
    const failedSnapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    const failedSnapshot = await failedSnapshotResponse.json();
    const failedSnapshotTransaction = failedSnapshot.transactions.find((item) => item.id === failedRfiTransaction.id);
    assert.notStrictEqual(failedSnapshotTransaction.assessmentStatus, 'Waiting for Information');

    const authFailureTransaction = await createTransaction('AuthFailureRfi');
    failNextRfiEmail = 'EAUTH';
    const authFailureResponse = await postRfi(authFailureTransaction);
    const authFailureBody = await authFailureResponse.json();
    assert.strictEqual(authFailureResponse.status, 502);
    assert.strictEqual(authFailureBody.code, 'EAUTH');
    assert.strictEqual(authFailureBody.message, 'Email authentication failed. Check EMAIL_USER and EMAIL_PASSWORD.');
    const authFailureActivity = await getActivity(authFailureTransaction);
    assert.ok(!authFailureActivity.some((entry) => entry.action === 'Request for Information Sent'));

    const resolvedRfiTransaction = await createTransaction('ResolvedRfi');
    const resolvedBeforeRfi = await resolveTransaction(resolvedRfiTransaction, { finalRiskLevel: 'Low' });
    assert.strictEqual(resolvedBeforeRfi.status, 200);
    const resolvedRfiResponse = await postRfi(resolvedRfiTransaction);
    assert.strictEqual(resolvedRfiResponse.status, 409);

    const originalTestMode = process.env.EMAIL_TEST_MODE;
    const originalEmailProvider = process.env.EMAIL_PROVIDER;
    process.env.EMAIL_TEST_MODE = 'true';
    const testModeTransaction = await createTransaction('TestModeRfi');
    const testModeRfiResponse = await postRfi(testModeTransaction);
    assert.strictEqual(testModeRfiResponse.status, 200);
    assert.strictEqual(sentRfiEmails.at(-1).deliveredTo, testModeTransaction.customerEmail);
    assert.strictEqual(sentRfiEmails.at(-1).testMode, true);
    assert.strictEqual(sentRfiEmails.at(-1).deliveredSubject, '[TEST] Additional Information Required for Your Transaction');
    process.env.EMAIL_PROVIDER = 'ethereal';
    const etherealTransaction = await createTransaction('EtherealRfi');
    const etherealResponse = await postRfi(etherealTransaction);
    const etherealBody = await etherealResponse.json();
    assert.strictEqual(etherealResponse.status, 200);
    assert.strictEqual(etherealBody.message, 'Test email created successfully. This message was not delivered to the customer.');
    assert.strictEqual(etherealBody.previewUrl, 'https://ethereal.email/message/mock-preview');
    assert.strictEqual(etherealBody.delivery.provider, 'ethereal');
    assert.strictEqual(etherealBody.delivery.recipientSource, 'stored');
    assert.ok(etherealBody.delivery.accepted[0].includes('***'));
    assert.strictEqual(sentRfiEmails.at(-1).etherealMode, true);
    assert.strictEqual(sentRfiEmails.at(-1).deliveredTo, etherealTransaction.customerEmail);
    assert.strictEqual(etherealTransaction.customerEmail, sentRfiEmails.at(-1).to);
    if (originalTestMode === undefined) delete process.env.EMAIL_TEST_MODE;
    else process.env.EMAIL_TEST_MODE = originalTestMode;
    if (originalEmailProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalEmailProvider;

    const actionTransaction = await createTransaction('Actions');
    const otherTransaction = await createTransaction('OtherActivity');
    const otherAction = await postAction(otherTransaction, {
      notes: 'Other transaction audit entry should stay separate.',
    });
    assert.strictEqual(otherAction.status, 201);

    const rfiResponse = await postAction(actionTransaction);
    const rfiBody = await rfiResponse.json();
    assert.strictEqual(rfiResponse.status, 201);
    assert.strictEqual(rfiBody.transaction.assessmentStatus, 'Waiting for Information');
    assert.ok(rfiBody.auditEntry.transactionId);
    assert.ok(rfiBody.auditEntry.alertId);
    assert.ok(rfiBody.auditEntry.caseId);
    assert.strictEqual(rfiBody.auditEntry.action, 'Request for Information');

    const strResponse = await postAction(actionTransaction, {
      actionType: 'STR_FILED',
      notes: 'STR filing completed for regulator review.',
    });
    const strBody = await strResponse.json();
    assert.strictEqual(strResponse.status, 201);
    assert.strictEqual(strBody.auditEntry.action, 'STR Filed');
    assert.strictEqual(strBody.transaction.finalRiskScore, null);
    assert.strictEqual(strBody.transaction.resolvedAt, undefined);

    const escalationResponse = await postAction(actionTransaction, {
      actionType: 'CASE_ESCALATED',
      notes: 'Escalating this case for senior compliance review.',
    });
    const escalationBody = await escalationResponse.json();
    assert.strictEqual(escalationResponse.status, 201);
    assert.strictEqual(escalationBody.transaction.assessmentStatus, 'Escalated');
    assert.strictEqual(escalationBody.auditEntry.action, 'Case Escalated');

    const repeatedEscalation = await postAction(actionTransaction, {
      actionType: 'CASE_ESCALATED',
      notes: 'Trying to escalate the same case again.',
    });
    assert.strictEqual(repeatedEscalation.status, 409);

    const resolvedActionResponse = await resolveTransaction(actionTransaction, { finalRiskLevel: 'Medium' });
    const resolvedActionBody = await resolvedActionResponse.json();
    assert.strictEqual(resolvedActionResponse.status, 200);
    const resolvedActions = resolvedActionBody.activityLogs.map((entry) => entry.action);
    assert.ok(resolvedActions.includes('Final Risk Assigned'));
    assert.ok(resolvedActions.includes('Assessment Resolved'));

    const afterResolutionAction = await postAction(actionTransaction, {
      actionType: 'RFI_REQUESTED',
      notes: 'Trying to request information after resolution.',
    });
    assert.strictEqual(afterResolutionAction.status, 409);

    const activityLogs = await getActivity(actionTransaction);
    const activityActions = activityLogs.map((entry) => entry.action);
    assert.ok(activityActions.includes('Request for Information'));
    assert.ok(activityActions.includes('STR Filed'));
    assert.ok(activityActions.includes('Case Escalated'));
    assert.ok(activityActions.includes('Final Risk Assigned'));
    assert.ok(activityActions.includes('Assessment Resolved'));
    assert.ok(activityLogs.every((entry) => entry.transactionId === actionTransaction.id));
    assert.ok(activityLogs.every((entry, index, list) => index === 0 || new Date(list[index - 1].createdAt) <= new Date(entry.createdAt)));

    const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    const snapshot = await snapshotResponse.json();
    assert.ok(snapshot.auditLogs.length >= activityLogs.length);
  } finally {
    if (suiteOriginalEmailProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = suiteOriginalEmailProvider;
    if (suiteOriginalTestMode === undefined) delete process.env.EMAIL_TEST_MODE;
    else process.env.EMAIL_TEST_MODE = suiteOriginalTestMode;
    await new Promise((resolve) => server.close(resolve));
  }
}

assertNewTransactionStoresInitialRisk()
  .then(() => console.log('Compliance engine tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
