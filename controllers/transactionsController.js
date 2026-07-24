const database = require('../src/database');
const { id } = require('../src/lib/ids');
const { broadcast } = require('../src/lib/socket');
const { ensureCaseAssignmentColumns, ensureStrWorkflowSchema, ensureDatabaseResolveColumns } = require('../src/lib/schema');
const transactionModel = require('../models/transactionModel');
const caseModel = require('../models/caseModel');
const userModel = require('../models/userModel');
const merchantModel = require('../models/merchantModel');
const merchantCddModel = require('../models/merchantCddModel');
const matchedRuleModel = require('../models/matchedRuleModel');
const auditLogModel = require('../models/auditLogModel');
const strReportModel = require('../models/strReportModel');
const rfiModel = require('../models/rfiModel');
const eddChecklistModel = require('../models/eddChecklistModel');
const {
  addWorkingDays,
  hasMeaningfulText,
  normalizeEvidence,
  formatSqlDateTime,
  buildTransactionSummary,
  buildStrAutoFill,
} = require('../src/lib/strDraft');
const { forbidJson, activePageForRole } = require('../src/middleware/auth');
const { ingestTransaction } = require('../src/transactionIngestion');
const { ensureRiskAndContactSchema } = require('../src/lib/schema');
const { checkLatestTransactionReply } = require('../src/services/rfiMailboxService');
const { logAdminAudit } = require('../src/lib/auditLog');
const { loadMerchantCddContext } = require('../src/lib/merchantCdd');
const { setEddChecklistField } = require('../src/lib/eddChecklist');
const { setCddChecklistField } = require('../src/lib/cddChecklist');
const { saveCddDocument, listCddDocuments } = require('../src/lib/cddDocuments');
const { buildMailboxReference } = require('../src/lib/rfiEvidence');
const { handleDatabaseRfiRequest } = require('../src/lib/rfiWorkflow');
const { handleDatabaseResolveRequest } = require('../src/lib/resolveWorkflow');
const {
  emptyStrAutoFill,
  stroReferralReasons,
  escalationDestinations,
  escalationReasons,
  STALE_CASE_MINUTES,
} = require('../src/constants');

async function transactionDetailPage(req, res) {
  await ensureCaseAssignmentColumns();
  await ensureStrWorkflowSchema();
  await ensureDatabaseResolveColumns();
  await ensureRiskAndContactSchema();

  const [transaction, caseRows, ruleRows, activityRows] = await Promise.all([
    transactionModel.findDetailById(req.params.id),
    caseModel.findDetailByTransactionId(req.params.id),
    matchedRuleModel.listByTransactionId(req.params.id).catch((error) => {
      console.error('Unable to load transaction matched rules', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
    auditLogModel.listByTransactionId(req.params.id).catch((error) => {
      console.error('Unable to load transaction activity logs', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
  ]);

  if (!transaction) {
    return res.status(404).render('transaction-detail', {
      title: 'Transaction Not Found',
      activePage: activePageForRole(req.session.user.role),
      transaction: null,
      currentUser: req.session.user,
      currentRole: req.session.user.role,
      caseRecord: null,
      riskContributions: [],
      activityLogs: [],
      strAutoFill: emptyStrAutoFill,
      cddContext: null,
      screeningRecords: [],
      rfiEvidence: [],
      cddDocuments: [],
    });
  }

  const caseRecord = caseRows[0] || null;

  // Field-level RBAC enforced here, server-side, not in the view template: contact info is
  // simply absent from the render data for roles that shouldn't have it, rather than hidden
  // with CSS. Analyst always has it as the first-line reviewer; Senior Analyst/STRO only once
  // the case is escalated to that role; Admin always has full access via Merchant Management.
  const role = req.session.user.role;
  const routedToRole = caseRecord?.assigned_role === role || caseRecord?.escalation_destination === role;
  const contactVisible = role === 'Admin' || role === 'Analyst' || ((role === 'Senior Analyst' || role === 'STRO') && routedToRole);
  if (!contactVisible) {
    delete transaction.contact_name;
    delete transaction.rfi_email;
    delete transaction.phone_number;
    // merchant_mid is the real acquirer/scheme-assigned merchant identifier (analogous to a
    // STAN number) - same visibility rule as the contact fields above: an Analyst loses it once
    // the case is routed away, and it's only ever restored for the Senior Analyst/STRO it was
    // routed to (or Admin, always).
    delete transaction.merchant_mid;
  } else if (role === 'Senior Analyst' || role === 'STRO') {
    await auditLogModel.insert({
      auditId: id('AUD'),
      transactionId: transaction.transaction_id,
      entityType: 'MerchantContact',
      entityId: caseRecord?.case_id || transaction.merchant_id,
      action: 'Merchant Contact Viewed',
      userId: req.session.user.id,
      notes: `Merchant contact details and merchant MID viewed by ${req.session.user.name} (${role}) for case ${caseRecord?.case_id || 'n/a'}, reference ${transaction.unique_transaction_reference || transaction.transaction_id}.`,
    });
  }

  const strAutoFill = buildStrAutoFill({
    transaction,
    caseRecord,
    matchedRules: ruleRows,
    activityLogs: activityRows,
  });

  // Merchant due-diligence context is investigative material, not a sensitive identifier -
  // visible to the Analyst from the start (unlike merchant_mid/contact info above), so it
  // doesn't follow the escalation gate.
  const [cddContext, screeningRows, evidenceRows, documentRows] = await Promise.all([
    loadMerchantCddContext(database, transaction.merchant_id, {
      transactionRiskLevel: transaction.initial_risk_level || transaction.risk_level,
      transactionId: transaction.transaction_id,
    }),
    merchantCddModel.listRecentScreeningRecords(transaction.merchant_id).catch(() => []),
    caseRecord?.case_id ? rfiModel.listCaseEvidence(caseRecord.case_id).catch(() => []) : Promise.resolve([]),
    listCddDocuments(database, transaction.transaction_id).catch(() => []),
  ]);

  return res.render('transaction-detail', {
    title: `Transaction ${transaction.transaction_id}`,
    activePage: activePageForRole(req.session.user.role),
    transaction,
    caseRecord,
    riskContributions: ruleRows,
    activityLogs: activityRows,
    strAutoFill,
    currentUser: req.session.user,
    currentRole: req.session.user.role,
    cddContext,
    screeningRecords: screeningRows,
    rfiEvidence: evidenceRows,
    cddDocuments: documentRows,
  });
}

async function assignToMe(req, res) {
  const currentUser = req.session.user;
  if (!['Analyst', 'Senior Analyst', 'STRO'].includes(currentUser.role)) {
    return forbidJson(res);
  }

  try {
    await ensureCaseAssignmentColumns();

    const caseRow = await caseModel.findWithAssigneeById(req.params.caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    const resolvedStatuses = ['Resolved', 'Dismissed as False Positive', 'STR Filed'];
    if (resolvedStatuses.includes(caseRow.status)) {
      return res.status(409).json({ success: false, message: 'Resolved cases cannot be assigned.' });
    }

    const requiredRole = caseRow.assigned_role || 'Analyst';
    if (currentUser.role !== requiredRole) {
      return res.status(403).json({
        success: false,
        message: `This case is currently routed to ${requiredRole} and cannot be claimed by ${currentUser.role}.`,
      });
    }

    if (caseRow.assigned_to) {
      const ownerName = caseRow.assigned_user_name || caseRow.assigned_to;
      return res.status(409).json({
        success: false,
        message: caseRow.assigned_to === currentUser.id
          ? 'This case is already assigned to you.'
          : `This case is already assigned to ${ownerName}.`,
      });
    }

    const dueAt = addWorkingDays(new Date(), 2);
    const dueAtSql = dueAt.toISOString().slice(0, 19).replace('T', ' ');
    const claimed = await caseModel.claimForAnalyst({ caseId: caseRow.case_id, userId: currentUser.id, dueAtSql });
    if (!claimed) {
      return res.status(409).json({ success: false, message: 'This case was assigned by another user. Please refresh the page.' });
    }

    const dueDateLabel = dueAt.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
    const auditMessage = `Case assigned to ${currentUser.name} with due date ${dueDateLabel}.`;
    const auditId = id('AUD');
    await auditLogModel.insert({
      auditId,
      transactionId: caseRow.transaction_id,
      entityType: 'Case',
      entityId: caseRow.case_id,
      action: 'Case Assigned',
      userId: currentUser.id,
      notes: auditMessage,
    });

    return res.status(200).json({
      success: true,
      message: 'Case assigned successfully.',
      case: {
        caseId: caseRow.case_id,
        transactionId: caseRow.transaction_id,
        assignedUserId: currentUser.id,
        assignedAnalyst: currentUser.name,
        assessmentStatus: 'Under Review',
        dueAt: dueAt.toISOString(),
      },
      auditEntry: {
        auditId,
        transactionId: caseRow.transaction_id,
        entityType: 'Case',
        entityId: caseRow.case_id,
        action: 'Case Assigned',
        userId: currentUser.id,
        userName: currentUser.name,
        userRole: currentUser.role,
        notes: auditMessage,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Assign to me failed', {
      caseId: req.params.caseId,
      userId: currentUser.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to assign this case right now.' });
  }
}

// Safety net for the analyst self-select workflow above: a Critical/High (or already-overdue)
// case that nobody has claimed within STALE_CASE_MINUTES gets pushed to whichever active
// Analyst currently has the fewest open cases, so high-risk work never sits idle just because
// the queue wasn't triaged in time. Reuses the same atomic "WHERE assigned_to IS NULL" guard as
// assign-to-me above so it can never clobber a manual claim made in between the SELECT and
// the UPDATE. user_id is left NULL on the audit entry since the actor is the system, not the
// analyst it assigned to - the audit-log views already render that as "System".
async function autoAssignStaleCases() {
  if (!database.isEnabled()) return;

  const staleCases = await caseModel.findStale(STALE_CASE_MINUTES);
  if (!staleCases.length) return;

  const analysts = await userModel.listActiveAnalystsByOpenCaseCount();
  if (!analysts.length) return;

  for (const staleCase of staleCases) {
    const analyst = analysts[0];
    const dueAt = addWorkingDays(new Date(), 2);
    const dueAtSql = dueAt.toISOString().slice(0, 19).replace('T', ' ');

    const assigned = await caseModel.autoAssign({ caseId: staleCase.case_id, analystId: analyst.user_id, dueAtSql });
    if (!assigned) continue; // claimed manually in the meantime

    analyst.open_cases += 1;
    analysts.sort((a, b) => a.open_cases - b.open_cases || a.user_name.localeCompare(b.user_name));

    const auditMessage = `Case auto-assigned to ${analyst.user_name} after sitting unassigned for over ${STALE_CASE_MINUTES} minutes.`;
    await auditLogModel.insert({
      auditId: id('AUD'),
      transactionId: staleCase.transaction_id,
      entityType: 'Case',
      entityId: staleCase.case_id,
      action: 'Case Auto-Assigned',
      userId: null,
      notes: auditMessage,
    });
  }
}

// The case-open triggers (see FYP_Transaction_Monitoring.sql) never set due_at, so an unclaimed
// case has no SLA clock until someone assigns it. That means a non-Critical/High case could sit
// unassigned indefinitely with no overdue signal at all. This backfills a due date - anchored to
// when the case was actually opened, not to whenever this job happens to run - for any case that
// doesn't have one yet, so overdue reporting works even before a claim. assignToMe/auto-assign
// still reset due_at to a fresh clock once someone actually takes ownership.
async function backfillCaseDueDates() {
  if (!database.isEnabled()) return;

  const cases = await caseModel.findWithoutDueDate();
  if (!cases.length) return;

  for (const caseRow of cases) {
    const dueAt = formatSqlDateTime(addWorkingDays(new Date(caseRow.created_at), 2));
    await caseModel.setDueDateIfMissing(caseRow.case_id, dueAt);
  }
}

async function loadRoleCaseContext(transactionId) {
  await ensureStrWorkflowSchema();
  return caseModel.findRoleContextByTransactionId(transactionId);
}

function isResolvedCaseStatus(status) {
  return ['Resolved', 'Dismissed as False Positive', 'STR Filed'].includes(status);
}

function isTerminalCaseContext(context) {
  return isResolvedCaseStatus(context?.case_status)
    || ['Filed', 'Not Required'].includes(context?.str_status);
}

function isRoutedToRole(context, role) {
  return context?.assigned_role === role || context?.escalation_destination === role;
}

async function auditCaseAction({ transactionId, caseId, action, userId, notes }) {
  await auditLogModel.insert({
    auditId: id('AUD'), transactionId, entityType: 'Case', entityId: caseId, action, userId, notes,
  });
}

async function referToStro(req, res) {
  if (req.session.user.role !== 'Senior Analyst') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isTerminalCaseContext(context)) {
    return res.status(409).json({ success: false, message: 'Terminal cases cannot be referred to STRO.' });
  }
  if (!isRoutedToRole(context, 'Senior Analyst')) {
    return res.status(403).json({ success: false, message: 'Only the Senior Analyst role currently assigned this escalation may refer it to STRO.' });
  }
  if (context.str_status || context.assigned_role === 'STRO' || context.escalation_destination === 'STRO') {
    return res.status(409).json({ success: false, message: 'This case has already been referred to STRO.' });
  }

  const referralReason = String(req.body.referralReason || '').trim();
  const referralSummary = String(req.body.referralSummary || '').trim();
  const seniorAnalystNotes = String(req.body.seniorAnalystNotes || '').trim();
  const supportingEvidence = normalizeEvidence(req.body.supportingEvidence);

  if (!stroReferralReasons.includes(referralReason)) {
    return res.status(400).json({ success: false, message: 'Please select a valid referral reason.' });
  }
  if (!hasMeaningfulText(referralSummary, 30)) {
    return res.status(400).json({ success: false, message: 'Summary for STRO must contain at least 30 meaningful characters.' });
  }
  if (!hasMeaningfulText(seniorAnalystNotes, 10)) {
    return res.status(400).json({ success: false, message: 'Senior Analyst notes must contain at least 10 meaningful characters.' });
  }
  if (!supportingEvidence.length) {
    return res.status(400).json({ success: false, message: 'Select at least one supporting evidence type.' });
  }

  const now = new Date();
  await caseModel.routeToStro({ caseId: context.case_id, userId: req.session.user.id, at: formatSqlDateTime(now) });
  await strReportModel.insertRecommended({
    strId: id('STR'),
    transactionId: context.transaction_id,
    caseId: context.case_id,
    referralReason,
    referralSummary,
    supportingEvidence,
    seniorAnalystNotes,
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'Case Referred to STRO',
    userId: req.session.user.id,
    notes: `Case referred to STRO by ${req.session.user.name} after senior review. Case unassigned pending STRO pickup.`,
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Recommended',
    userId: req.session.user.id,
    notes: 'STR review recommended by Senior Analyst.',
  });

  return res.status(200).json({
    success: true,
    message: 'Case referred to STRO successfully.',
    assessmentStatus: 'Escalated',
    escalatedTo: 'STRO',
    assignedRole: 'STRO',
    strStatus: 'Recommended',
  });
}

async function escalate(req, res) {
  if (req.session.user.role !== 'Analyst') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isTerminalCaseContext(context)) {
    return res.status(409).json({ success: false, message: 'Terminal cases cannot be escalated.' });
  }
  if (context.str_status === 'Filed') {
    return res.status(409).json({ success: false, message: 'Filed STR cases cannot be referred again.' });
  }
  if (context.assigned_role || context.escalation_destination || context.str_status) {
    return res.status(409).json({ success: false, message: 'This case has already been routed.' });
  }

  const destination = String(req.body.escalationDestination || '').trim();
  const reason = String(req.body.escalationReason || '').trim();
  const notes = String(req.body.escalationNotes || '').trim();
  if (!escalationDestinations.includes(destination)) {
    return res.status(400).json({ success: false, message: 'Please select a valid escalation destination.' });
  }
  if (!escalationReasons.includes(reason)) {
    return res.status(400).json({ success: false, message: 'Please select a valid escalation reason.' });
  }
  if (!hasMeaningfulText(notes, 10)) {
    return res.status(400).json({ success: false, message: 'Escalation notes must contain at least 10 meaningful characters.' });
  }

  if (destination === 'Senior Analyst') {
    await caseModel.routeToSeniorAnalyst({ caseId: context.case_id, userId: req.session.user.id, notes });
    await transactionModel.updateActionStatus(context.transaction_id, 'Pending Senior Review');
    await auditCaseAction({
      transactionId: context.transaction_id,
      caseId: context.case_id,
      action: 'Case Escalated to Senior Analyst',
      userId: req.session.user.id,
      notes: `Case escalated to Senior Analyst for critical-risk review by ${req.session.user.name}. Case unassigned pending Senior Analyst pickup.`,
    });
    return res.status(200).json({
      success: true,
      message: 'Case escalated to Senior Analyst.',
      assessmentStatus: 'Escalated',
      escalatedTo: 'Senior Analyst',
      assignedRole: 'Senior Analyst',
      strStatus: 'Not Started',
    });
  }

  const escalatedAtSql = formatSqlDateTime(new Date());
  await caseModel.routeToStro({
    caseId: context.case_id, userId: req.session.user.id, notes, at: escalatedAtSql,
  });
  await transactionModel.updateActionStatus(context.transaction_id, 'Escalated');
  await strReportModel.insertRecommended({
    strId: id('STR'),
    transactionId: context.transaction_id,
    caseId: context.case_id,
    referralReason: reason,
    referralSummary: notes,
    supportingEvidence: ['Transaction behaviour'],
    seniorAnalystNotes: notes,
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'Case Referred to STRO',
    userId: req.session.user.id,
    notes: `Case referred directly to STRO by ${req.session.user.name} for suspicious transaction reporting review. Case unassigned pending STRO pickup.`,
  });
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Recommended',
    userId: req.session.user.id,
    notes: 'STR review recommended by Analyst.',
  });
  return res.status(200).json({
    success: true,
    message: 'Case referred directly to STRO.',
    assessmentStatus: 'Escalated',
    escalatedTo: 'STRO',
    assignedRole: 'STRO',
    strStatus: 'Recommended',
  });
}

function validateStrTransition(currentStatus, nextStatus) {
  const current = currentStatus || 'Recommended';
  const allowed = {
    Recommended: ['Filed', 'Not Required'],
    Filed: [],
    'Not Required': [],
  };
  return (allowed[current] || []).includes(nextStatus);
}

async function fileStr(req, res) {
  if (req.session.user.role !== 'STRO') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isTerminalCaseContext(context)) {
    return res.status(409).json({ success: false, message: 'Terminal cases cannot be updated for STR.' });
  }
  if (context.assigned_role !== 'STRO' && context.escalation_destination !== 'STRO') {
    return res.status(403).json({ success: false, message: 'This case is not routed to STRO.' });
  }
  if (!context.str_status) {
    return res.status(409).json({ success: false, message: 'This case has not been referred for STR review.' });
  }

  const nextStatus = String(req.body.strStatus || '').trim();
  if (nextStatus !== 'Filed') {
    return res.status(400).json({ success: false, message: 'Invalid STR status.' });
  }
  if (!validateStrTransition(context.str_status, nextStatus)) {
    return res.status(409).json({ success: false, message: `Cannot change STR status from ${context.str_status} to ${nextStatus}.` });
  }

  const reportingReason = String(req.body.reportingReason || '').trim();
  const suspicionSummary = String(req.body.suspicionSummary || '').trim();
  const stroNotes = String(req.body.stroNotes || '').trim();
  const referenceNumber = String(req.body.referenceNumber || '').trim();
  const filingDate = String(req.body.filingDate || '').trim();
  const supportingEvidence = normalizeEvidence(req.body.supportingEvidence);
  const confirmation = req.body.confirmAccurate === true || req.body.confirmAccurate === 'true' || req.body.confirmAccurate === 'on';

  if (!hasMeaningfulText(reportingReason, 20)) {
    return res.status(400).json({ success: false, message: 'Reporting reason must contain at least 20 meaningful characters.' });
  }
  if (!hasMeaningfulText(suspicionSummary, 30)) {
    return res.status(400).json({ success: false, message: 'Suspicion summary must contain at least 30 meaningful characters.' });
  }
  if (!hasMeaningfulText(stroNotes, 10)) {
    return res.status(400).json({ success: false, message: 'STRO notes must contain at least 10 meaningful characters.' });
  }
  if (!supportingEvidence.length) {
    return res.status(400).json({ success: false, message: 'Select at least one supporting evidence type.' });
  }
  if (nextStatus === 'Filed' && (!referenceNumber || !filingDate || !confirmation)) {
    return res.status(400).json({ success: false, message: 'Filing reference, filing date and confirmation are required to mark an STR as filed.' });
  }

  const transactionSummary = buildTransactionSummary(context);
  const preparedBy = context.prepared_by || req.session.user.id;
  const filedBy = nextStatus === 'Filed' ? req.session.user.id : context.filed_by || null;
  const filedAt = nextStatus === 'Filed' ? formatSqlDateTime(new Date()) : context.filed_at || null;
  const action = 'STR Filed';
  const notes = `STR filed with internal reference ${referenceNumber}.`;

  await strReportModel.updateFiling({
    caseId: context.case_id,
    strStatus: nextStatus,
    referenceNumber: referenceNumber || context.reference_number || null,
    reportingReason,
    suspicionSummary,
    transactionSummary,
    supportingEvidence,
    stroNotes,
    preparedBy,
    filedBy,
    filingDate: filingDate || context.filing_date || null,
    filedAt,
  });
  if (nextStatus === 'Filed') {
    await ensureDatabaseResolveColumns();
    const resolvedAtSql = new Date();
    const finalRiskScore = context.final_risk_score ?? context.risk_score;
    const finalRiskLevel = context.final_risk_level || context.risk_level;
    await caseModel.markStrFiled({ caseId: context.case_id, resolvedAt: resolvedAtSql, resolvedBy: req.session.user.id });
    await transactionModel.updateFinalRisk(context.transaction_id, { finalRiskScore, finalRiskLevel });
  }
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action,
    userId: req.session.user.id,
    notes,
  });

  return res.status(200).json({
    success: true,
    message: notes,
    strStatus: nextStatus,
    referenceNumber: referenceNumber || context.reference_number || null,
    filingDate: filingDate || context.filing_date || null,
  });
}

async function strNotRequired(req, res) {
  if (req.session.user.role !== 'STRO') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isTerminalCaseContext(context)) {
    return res.status(409).json({ success: false, message: 'Terminal cases cannot be updated for STR.' });
  }
  if (context.assigned_role !== 'STRO' && context.escalation_destination !== 'STRO') {
    return res.status(403).json({ success: false, message: 'This case is not routed to STRO.' });
  }
  if (!validateStrTransition(context.str_status || 'Recommended', 'Not Required')) {
    return res.status(409).json({ success: false, message: `Cannot mark STR as Not Required from ${context.str_status}.` });
  }

  const reason = String(req.body.reason || '').trim();
  if (!hasMeaningfulText(reason, 20)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful reason of at least 20 characters.' });
  }

  await strReportModel.markNotRequired(context.case_id, reason);
  await caseModel.markStrNotRequired({
    caseId: context.case_id,
    resolvedAt: new Date(),
    resolvedBy: req.session.user.id,
  });
  await transactionModel.updateActionStatus(context.transaction_id, 'Resolved');
  await auditCaseAction({
    transactionId: context.transaction_id,
    caseId: context.case_id,
    action: 'STR Marked Not Required',
    userId: req.session.user.id,
    notes: 'STR marked not required after STRO review.',
  });

  return res.status(200).json({ success: true, message: 'STR marked as not required.', strStatus: 'Not Required' });
}

// Small connection-status + live-refresh script (replaces the old dashboard/analytics SPA
// bundle that used to live here). Any page with a [data-live-refresh] element soft-reloads
// shortly after a new transaction event, so live pages reflect ingestion without polling.
// Requires the socket.io client (served by the socket.io server itself at
// /socket.io/socket.io.js) to be loaded on the page before this script - see footer.ejs.
function liveRefreshScript(req, res) {
  res.type('application/javascript');
  res.send(`(function () {
  var dot = document.querySelector('#connectionDot');
  var text = document.querySelector('#connectionText');
  var socket = io();
  var refreshTimer = null;

  socket.on('connect', function () {
    if (dot) dot.classList.add('online');
    if (text) text.textContent = 'Live stream connected';
  });

  socket.on('disconnect', function () {
    if (dot) dot.classList.remove('online');
    if (text) text.textContent = 'Reconnecting';
  });

  socket.on('connect_error', function () {
    if (dot) dot.classList.remove('online');
    if (text) text.textContent = 'Reconnecting';
  });

  socket.on('transaction', function () {
    if (!document.querySelector('[data-live-refresh]')) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      window.location.reload();
    }, 1200);
  });
})();`);
}

// Real-time ingestion entry point: this is what makes the system "live" - a transaction only
// ever appears because something actually called this (the historical import script, or a
// real upstream feed/form), never because of a background generator.
async function ingestTransactionEndpoint(req, res) {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!req.body.merchantId) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  try {
    const merchantRow = await merchantModel.findRiskSnapshotById(req.body.merchantId);
    const merchant = merchantRow
      ? {
        merchantMid: merchantRow.merchant_mid,
        merchantCountry: merchantRow.merchant_country,
        riskTier: merchantRow.risk_tier,
        mccRiskScore: merchantRow.mcc_risk_score,
      }
      : { merchantMid: null, merchantCountry: 'SG', riskTier: 'Standard', mccRiskScore: 0 };

    const raw = {
      id: req.body.id || id('TXN'),
      merchantId: req.body.merchantId,
      storeId: req.body.storeId || null,
      amount,
      method: req.body.method || 'card',
      scheme: req.body.scheme || null,
      issuer: req.body.issuer || null,
      issuerBank: req.body.issuerBank || null,
      cardBin: req.body.cardBin || null,
      cardLast4: req.body.cardLast4 || null,
      cvvValidationResult: req.body.cvvValidationResult || null,
      expiryValidationResult: req.body.expiryValidationResult || null,
      transactionCode: req.body.transactionCode || null,
      transactionType: req.body.transactionType || 'sale',
      entryMode: req.body.entryMode || 'manual',
      status: req.body.status || 'captured',
      statusLabel: req.body.statusLabel || 'Captured',
      statusTone: req.body.statusTone || 'success',
      net: req.body.net ?? amount,
      fee: req.body.fee ?? 0,
      txnTime: req.body.txnTime ? new Date(req.body.txnTime) : new Date(),
      note: req.body.note || null,
      cardRef: req.body.cardRef || null,
    };

    const evaluation = await ingestTransaction(database, raw, merchant, { broadcast });
    return res.status(201).json({ transactionId: raw.id, ...evaluation });
  } catch (error) {
    console.error('Transaction ingestion failed', { message: error.message });
    return res.status(500).json({ error: 'Unable to ingest transaction' });
  }
}

async function latestRfiResponseEndpoint(req, res) {
  if (!req.session?.user || !['Admin', 'Analyst', 'Senior Analyst', 'STRO'].includes(req.session.user.role)) {
    return forbidJson(res);
  }

  const transactionId = String(req.params.id || '').trim();
  try {
    const { mailboxResult: result, detection } = await checkLatestTransactionReply(transactionId);
    if (result.found && result.message) {
      const automaticDisplay = req.query.source === 'poll';
      await logAdminAudit({
        action: automaticDisplay ? 'RFI_RESPONSE_AUTO_DISPLAYED' : 'RFI_RESPONSE_VIEWED',
        userId: req.session.user.id,
        transactionId,
        entityType: 'RFI',
        // entity_id is VARCHAR(40); mailboxReference ("Message-ID <...>") is a display string that
        // regularly runs longer than that, so it must be truncated rather than passed through raw.
        entityId: String(detection.mailboxReference || transactionId).slice(0, 40),
        notes: automaticDisplay
          ? 'The merchant RFI response was detected and displayed by transaction-page polling.'
          : 'The merchant RFI response was opened through Load Response.',
      });
    }

    return res.status(200).json({
      success: true,
      transactionId,
      receiptLogged: Boolean(detection.created),
      ...result,
    });
  } catch (error) {
    console.error('Unable to retrieve RFI response email', {
      transactionId,
      code: error.code || 'EMAIL_RETRIEVAL_FAILED',
      message: error.message,
    });
    return res.status(502).json({
      success: false,
      code: error.code || 'EMAIL_RETRIEVAL_FAILED',
      message: 'Unable to retrieve the latest RFI response from the mailbox.',
    });
  }
}

// Senior Sign-off is the one EDD checklist item that stays a manual attestation - it's an
// approval decision, not evidence, so there's no document type to upload for it. The other
// three EDD fields (sourceOfFunds, siteVisit, enhancedVerification) are set automatically by
// uploadCaseDocument below when a matching document is uploaded, never through this endpoint.
const EDD_CHECKLIST_ROLE_FIELDS = {
  'Senior Analyst': ['seniorSignoff'],
};

async function updateCaseEddChecklist(req, res) {
  const currentUser = req.session?.user;
  const allowedFields = currentUser ? EDD_CHECKLIST_ROLE_FIELDS[currentUser.role] : null;
  if (!allowedFields) return forbidJson(res);

  const fieldKey = String(req.body.fieldKey || '').trim();
  if (!allowedFields.includes(fieldKey)) {
    return res.status(403).json({ success: false, message: `Your role may not set the "${fieldKey || 'requested'}" checklist item.` });
  }
  const completed = req.body.completed === true || req.body.completed === '1' || req.body.completed === 'true';
  const notes = String(req.body.notes || '').trim();
  if (completed && !hasMeaningfulText(notes, 10)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful note of at least 10 characters when marking a checklist item complete.' });
  }

  await ensureRiskAndContactSchema();
  const transactionId = req.params.id;
  const caseContext = await loadRoleCaseContext(transactionId);
  if (!caseContext?.case_id) {
    return res.status(400).json({ success: false, message: 'EDD updates require an active transaction case.' });
  }
  if (isTerminalCaseContext(caseContext)) {
    return res.status(409).json({ success: false, message: 'CDD/EDD checks cannot be changed after the case is closed.' });
  }
  const merchantId = await transactionModel.findMerchantIdById(transactionId);
  if (!merchantId) return res.status(404).json({ success: false, message: 'Transaction not found' });
  const cddContext = await loadMerchantCddContext(database, merchantId, {
    transactionRiskLevel: caseContext.risk_level,
    transactionId,
  });
  if (!cddContext.eddRequired) {
    return res.status(409).json({ success: false, message: 'EDD sign-off is not required for this case.' });
  }

  const checklist = await eddChecklistModel.findByTransactionId(transactionId);
  if (checklist?.senior_signoff_completed) {
    return res.status(409).json({
      success: false,
      message: 'Senior Sign-off has already been completed and cannot be changed.',
    });
  }
  if (!completed) {
    return res.status(400).json({
      success: false,
      message: 'Senior Sign-off is a one-time approval and must be submitted as complete.',
    });
  }
  if (completed) {
    if (
      !checklist?.source_of_funds_verified
      || !checklist?.site_visit_completed
      || !checklist?.enhanced_verification_completed
    ) {
      return res.status(400).json({
        success: false,
        message: 'Complete Source of Funds, Site Visit, and Enhanced Verification before providing Senior Sign-off.',
      });
    }
  }

  await setEddChecklistField(database, {
    transactionId, merchantId, fieldKey, completed, notes: notes || null, userId: currentUser.id,
  });
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId,
    entityType: 'Merchant',
    entityId: merchantId,
    action: 'Merchant EDD Checklist Updated',
    userId: currentUser.id,
    notes: `${fieldKey} set to ${completed ? 'complete' : 'incomplete'} by ${currentUser.name} (${currentUser.role}).`,
  });

  return res.status(200).json({ success: true, fieldKey, completed });
}

// Separate case-workspace upload duties: Analysts provide CDD evidence and Senior Analysts
// provide EDD evidence. Admin transaction access is read-only.
const DOCUMENT_TYPE_ROLE_MAP = {
  Analyst: ['Business Registration', 'Screening'],
  'Senior Analyst': ['Source of Funds', 'Site Visit', 'Enhanced Verification'],
};

// A successful upload IS the checklist evidence, so the matching checklist field is completed
// automatically here rather than through a separate manual form - see setCddChecklistField/
// setEddChecklistField below. The upload's own documentNotes becomes the checklist note, so
// there is only ever one notes field for a given piece of evidence.
const CDD_DOCUMENT_TYPE_TO_FIELD = {
  'Business Registration': 'businessRegistration',
  Screening: 'screening',
};
const EDD_DOCUMENT_TYPE_TO_FIELD = {
  'Source of Funds': 'sourceOfFunds',
  'Site Visit': 'siteVisit',
  'Enhanced Verification': 'enhancedVerification',
};

async function authorizeCaseDocumentUpload(req, res, next) {
  const currentUser = req.session?.user;
  if (!currentUser || !DOCUMENT_TYPE_ROLE_MAP[currentUser.role]) return res.status(403).send('Forbidden');

  const transactionCase = await transactionModel.findMerchantAndLatestCaseId(req.params.id);
  if (!transactionCase?.merchant_id) return res.status(404).send('Transaction not found');
  if (!transactionCase.case_id) {
    return res.status(400).send('Supporting documents can only be uploaded to an active transaction case.');
  }
  if (isTerminalCaseContext(transactionCase)) {
    return res.status(409).send('Documents cannot be uploaded after the case is closed.');
  }
  const cddContext = await loadMerchantCddContext(database, transactionCase.merchant_id, {
    transactionRiskLevel: transactionCase.risk_level,
    transactionId: req.params.id,
  });
  if (currentUser.role === 'Analyst' && cddContext.cddComplete) {
    return res.status(409).send('CDD is already complete; no additional CDD document is required.');
  }
  const eddChecklist = cddContext.eddChecklist || {};
  const eddEvidenceOutstanding = cddContext.eddRequired && (
    !eddChecklist.source_of_funds_verified
    || !eddChecklist.site_visit_completed
    || !eddChecklist.enhanced_verification_completed
  );
  if (currentUser.role === 'Senior Analyst' && !eddEvidenceOutstanding) {
    return res.status(409).send('EDD is not outstanding for this case.');
  }
  req.caseDocumentContext = transactionCase;
  req.caseDocumentCddContext = cddContext;
  return next();
}

async function uploadCaseDocument(req, res) {
  const currentUser = req.session?.user;
  const allowedTypes = currentUser ? DOCUMENT_TYPE_ROLE_MAP[currentUser.role] : null;
  if (!allowedTypes || !req.file) return res.status(403).send('Forbidden');

  const documentType = String(req.body.documentType || '').trim();
  if (!allowedTypes.includes(documentType)) return res.status(403).send('Forbidden');

  await ensureRiskAndContactSchema();
  const transactionCase = req.caseDocumentContext
    || await transactionModel.findMerchantAndLatestCaseId(req.params.id);
  const merchantId = transactionCase?.merchant_id;
  if (!merchantId) return res.status(404).send('Transaction not found');
  const caseId = transactionCase?.case_id;
  if (!caseId) return res.status(400).send('Supporting documents can only be uploaded to an active transaction case.');
  if (isTerminalCaseContext(transactionCase)) {
    return res.status(409).send('Documents cannot be uploaded after the case is closed.');
  }
  const cddContext = req.caseDocumentCddContext
    || await loadMerchantCddContext(database, merchantId, {
      transactionRiskLevel: transactionCase.risk_level,
      transactionId: req.params.id,
    });
  const cddChecklist = cddContext.cddChecklist || {};
  const eddChecklist = cddContext.eddChecklist || {};
  const outstandingDocument = {
    'Business Registration': !cddChecklist.business_registration_verified,
    Screening: !cddChecklist.screening_verified,
    'Source of Funds': cddContext.eddRequired && !eddChecklist.source_of_funds_verified,
    'Site Visit': cddContext.eddRequired && !eddChecklist.site_visit_completed,
    'Enhanced Verification': cddContext.eddRequired && !eddChecklist.enhanced_verification_completed,
  };
  if (!outstandingDocument[documentType]) {
    return res.status(409).send('This due-diligence item is already complete or is not required.');
  }

  const documentNotes = String(req.body.documentNotes || '').trim() || null;
  const documentId = await saveCddDocument(database, {
    merchantId,
    transactionId: req.params.id,
    caseId,
    documentType,
    originalFilename: req.file.originalname,
    storedFilename: req.file.filename,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
    notes: documentNotes,
    uploadedBy: currentUser.id,
  });
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId: req.params.id,
    entityType: 'MerchantCddDocument',
    entityId: documentId,
    action: 'Merchant CDD Document Uploaded',
    userId: currentUser.id,
    notes: `${documentType} document "${req.file.originalname}" uploaded for transaction ${req.params.id}, case ${caseId}, by ${currentUser.name} (${currentUser.role}).`,
  });

  const cddFieldKey = CDD_DOCUMENT_TYPE_TO_FIELD[documentType];
  if (cddFieldKey) {
    await setCddChecklistField(database, {
      transactionId: req.params.id, merchantId, fieldKey: cddFieldKey, completed: true, notes: documentNotes, userId: currentUser.id,
    });
    await auditLogModel.insert({
      auditId: id('AUD'),
      transactionId: req.params.id,
      entityType: 'Merchant',
      entityId: merchantId,
      action: 'Merchant CDD Checklist Updated',
      userId: currentUser.id,
      notes: `${cddFieldKey} set to complete by ${currentUser.name} (${currentUser.role}) via document upload.`,
    });
  }
  const eddFieldKey = EDD_DOCUMENT_TYPE_TO_FIELD[documentType];
  if (eddFieldKey) {
    await setEddChecklistField(database, {
      transactionId: req.params.id, merchantId, fieldKey: eddFieldKey, completed: true, notes: documentNotes, userId: currentUser.id,
    });
    await auditLogModel.insert({
      auditId: id('AUD'),
      transactionId: req.params.id,
      entityType: 'Merchant',
      entityId: merchantId,
      action: 'Merchant EDD Checklist Updated',
      userId: currentUser.id,
      notes: `${eddFieldKey} set to complete by ${currentUser.name} (${currentUser.role}) via document upload.`,
    });
  }

  return res.redirect(`/transactions/${req.params.id}`);
}

const RFI_EVIDENCE_TYPES = ['RFI Reply Reviewed', 'Document Reference', 'Analyst Finding', 'Other'];

async function logRfiEvidence(req, res) {
  const currentUser = req.session?.user;
  if (!currentUser || !['Analyst', 'Senior Analyst', 'STRO'].includes(currentUser.role)) {
    return forbidJson(res);
  }

  const transactionId = String(req.params.id || '').trim();
  const evidenceType = String(req.body.evidenceType || '').trim();
  const description = String(req.body.description || '').trim();
  if (!RFI_EVIDENCE_TYPES.includes(evidenceType)) {
    return res.status(400).json({ success: false, message: 'Invalid evidence type.' });
  }
  if (!hasMeaningfulText(description, 10)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful description of at least 10 characters.' });
  }

  await ensureRiskAndContactSchema();
  const caseId = await caseModel.findLatestIdByTransactionId(transactionId);
  if (!caseId) return res.status(404).json({ success: false, message: 'No case found for this transaction.' });

  // Cross-checked against the real mailbox instead of trusting free-standing text - see
  // rfiEvidence.js. An analyst can mischaracterize a real reply, but can no longer log evidence
  // for a reply that was never received.
  let mailboxReference = null;
  if (evidenceType === 'RFI Reply Reviewed') {
    let verification;
    try {
      verification = await buildMailboxReference(transactionId);
    } catch (error) {
      console.error('Unable to verify RFI reply for evidence log', { transactionId, message: error.message });
      return res.status(502).json({ success: false, message: 'Unable to check the mailbox for a matching reply. Try again shortly.' });
    }
    if (!verification.found) {
      return res.status(400).json({
        success: false,
        message: 'No matching reply was found in the mailbox for this transaction. "RFI Reply Reviewed" evidence requires a real reply on file.',
      });
    }
    mailboxReference = verification.reference;
  }

  const evidenceId = id('EVD');
  await rfiModel.insertCaseEvidence({
    evidenceId, caseId, transactionId, evidenceType, description, mailboxReference, recordedBy: currentUser.id,
  });
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId,
    entityType: 'Case',
    entityId: caseId,
    action: 'RFI Evidence Logged',
    userId: currentUser.id,
    notes: `${evidenceType}: ${description}${mailboxReference ? ` (${mailboxReference})` : ''}`,
  });

  return res.status(200).json({
    success: true,
    evidence: {
      evidenceId, evidenceType, description, mailboxReference, recordedBy: currentUser.id, recordedAt: new Date().toISOString(),
    },
  });
}

function apiNotFound(req, res) {
  if (/^\/api\/transactions\/[^/]+\/rfi\/?$/.test(req.originalUrl)) {
    return res.status(404).json({
      success: false,
      message: 'RFI route not found.',
    });
  }

  res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
}

function sendRfi(req, res) {
  return handleDatabaseRfiRequest(req, res);
}

function resolveAssessment(req, res) {
  return handleDatabaseResolveRequest(req, res);
}

module.exports = {
  transactionDetailPage,
  assignToMe,
  autoAssignStaleCases,
  backfillCaseDueDates,
  referToStro,
  escalate,
  validateStrTransition,
  fileStr,
  strNotRequired,
  liveRefreshScript,
  ingestTransactionEndpoint,
  latestRfiResponseEndpoint,
  updateCaseEddChecklist,
  authorizeCaseDocumentUpload,
  uploadCaseDocument,
  logRfiEvidence,
  apiNotFound,
  sendRfi,
  resolveAssessment,
  DOCUMENT_TYPE_ROLE_MAP,
  CDD_DOCUMENT_TYPE_TO_FIELD,
  EDD_DOCUMENT_TYPE_TO_FIELD,
};
