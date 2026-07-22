const database = require('../src/database');
const { id } = require('../src/lib/ids');
const { broadcast } = require('../src/lib/socket');
const { ensureCaseAssignmentColumns, ensureStrWorkflowSchema, ensureDatabaseResolveColumns } = require('../src/lib/schema');
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
const { fetchLatestRfiResponse } = require('../src/services/rfiInboxService');
const { loadMerchantCddContext } = require('../src/lib/merchantCdd');
const { setEddChecklistField } = require('../src/lib/eddChecklist');
const { buildMailboxReference } = require('../src/lib/rfiEvidence');
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

  const [transactionRows, caseRows, ruleRows, activityRows] = await Promise.all([
    database.query(
      `SELECT t.*, m.merchant_name, m.merchant_mid, m.mcc_risk_score,
              mc.contact_name, mc.rfi_email, mc.phone_number,
              mrp.profile_risk_score, mrp.profile_risk_level, mrp.transaction_count AS profile_transaction_count,
              mrp.flagged_transaction_rate, mrp.flagged_transaction_count AS profile_flagged_transaction_count,
              mrp.escalation_count AS profile_escalation_count,
              mrp.risk_last_calculated_at
       FROM transactions t
       LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
       LEFT JOIN merchant_contacts mc ON mc.merchant_id = t.merchant_id AND mc.status = 'Active'
       LEFT JOIN merchant_risk_profiles mrp ON mrp.merchant_mid = m.merchant_mid
       WHERE t.transaction_id = ?
       LIMIT 1`,
      [req.params.id],
    ).then(([rows]) => rows),
    database.query(
      `SELECT c.case_id, c.transaction_id, c.created_by, c.assigned_to, c.status, c.notes,
              c.assigned_role, c.escalation_destination, c.referred_to_stro_at, c.referred_to_stro_by,
              c.last_actioned_by, c.last_actioned_at,
              c.due_at, c.created_at, c.updated_at, u.user_name AS assigned_user_name,
              c.decision, c.resolution_reason, c.analyst_notes, c.resolved_at, c.resolved_by,
              resolver.user_name AS resolved_by_name,
              sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
              sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
              sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by,
              sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason, sr.updated_at AS str_updated_at,
              prepared.user_name AS prepared_by_name,
              filed.user_name AS filed_by_name, referred.user_name AS referred_by_user_name,
              referred.user_role AS referred_by_user_role,
              lastActor.user_name AS last_actioned_by_name
       FROM cases c
       LEFT JOIN users u ON u.user_id = c.assigned_to
       LEFT JOIN str_reports sr ON sr.case_id = c.case_id
       LEFT JOIN users prepared ON prepared.user_id = sr.prepared_by
       LEFT JOIN users filed ON filed.user_id = sr.filed_by
       LEFT JOIN users referred ON referred.user_id = c.referred_to_stro_by
       LEFT JOIN users resolver ON resolver.user_id = c.resolved_by
       LEFT JOIN users lastActor ON lastActor.user_id = c.last_actioned_by
       WHERE c.transaction_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.id],
    ).then(([rows]) => rows),
    database.query(
      `SELECT tmr.rule_id, tmr.matched_at, cr.rule_name, cr.risk_level, cr.reason, cr.weight, cr.rule_type
       FROM transaction_matched_rules tmr
       LEFT JOIN compliance_rules cr ON cr.rule_id = tmr.rule_id
       WHERE tmr.transaction_id = ?
       ORDER BY tmr.matched_at ASC`,
      [req.params.id],
    ).then(([rows]) => rows).catch((error) => {
      console.error('Unable to load transaction matched rules', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
    database.query(
      `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action, al.user_id, al.notes, al.created_at,
              u.user_name, u.user_role
       FROM audit_logs al
       LEFT JOIN users u ON u.user_id = al.user_id
       WHERE al.transaction_id = ?
       ORDER BY al.created_at ASC`,
      [req.params.id],
    ).then(([rows]) => rows).catch((error) => {
      console.error('Unable to load transaction activity logs', {
        transactionId: req.params.id,
        message: error.message,
      });
      return [];
    }),
  ]);

  const transaction = transactionRows[0] || null;
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
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id('AUD'),
        transaction.transaction_id,
        'MerchantContact',
        caseRecord?.case_id || transaction.merchant_id,
        'Merchant Contact Viewed',
        req.session.user.id,
        `Merchant contact details and merchant MID viewed by ${req.session.user.name} (${role}) for case ${caseRecord?.case_id || 'n/a'}, reference ${transaction.unique_transaction_reference || transaction.transaction_id}.`,
      ],
    );
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
  const [cddContext, screeningRows, evidenceRows] = await Promise.all([
    loadMerchantCddContext(database, transaction.merchant_id),
    database.query(
      `SELECT screening_id, screening_type, result, screened_against, notes, screened_at
       FROM merchant_screening_records WHERE merchant_id = ? ORDER BY screened_at DESC LIMIT 5`,
      [transaction.merchant_id],
    ).then(([r]) => r).catch(() => []),
    caseRecord?.case_id ? database.query(
      `SELECT evidence_id, evidence_type, description, mailbox_reference, recorded_by, recorded_at
       FROM case_rfi_evidence WHERE case_id = ? ORDER BY recorded_at DESC`,
      [caseRecord.case_id],
    ).then(([r]) => r).catch(() => []) : Promise.resolve([]),
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
  });
}

async function assignToMe(req, res) {
  const currentUser = req.session.user;
  if (!['Analyst', 'Senior Analyst', 'STRO'].includes(currentUser.role)) {
    return forbidJson(res);
  }

  try {
    await ensureCaseAssignmentColumns();

    const [rows] = await database.query(
      `SELECT c.case_id, c.transaction_id, c.assigned_to, c.assigned_role, c.status, c.due_at,
              u.user_name AS assigned_user_name
       FROM cases c
       LEFT JOIN users u ON u.user_id = c.assigned_to
       WHERE c.case_id = ?
       LIMIT 1`,
      [req.params.caseId],
    );
    const caseRow = rows[0];
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
    const [updateResult] = await database.execute(
      `UPDATE cases
       SET assigned_to = ?, status = 'Under Review', due_at = ?,
           last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ? AND assigned_to IS NULL`,
      [currentUser.id, dueAtSql, currentUser.id, caseRow.case_id],
    );
    if (updateResult.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'This case was assigned by another user. Please refresh the page.' });
    }

    const dueDateLabel = dueAt.toLocaleDateString('en-SG');
    const auditMessage = `Case assigned to ${currentUser.name} with due date ${dueDateLabel}.`;
    const auditId = id('AUD');
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        auditId,
        caseRow.transaction_id,
        'Case',
        caseRow.case_id,
        'Case Assigned',
        currentUser.id,
        auditMessage,
      ],
    );

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

  const [staleCases] = await database.query(
    `SELECT c.case_id, c.transaction_id
     FROM cases c
     JOIN transactions t ON t.transaction_id = c.transaction_id
     WHERE c.assigned_to IS NULL
       AND c.assigned_role IS NULL
       AND c.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')
       AND (t.risk_level IN ('Critical', 'High') OR (c.due_at IS NOT NULL AND c.due_at < NOW()))
       AND c.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [STALE_CASE_MINUTES],
  );
  if (!staleCases.length) return;

  const [analysts] = await database.query(
    `SELECT u.user_id, u.user_name,
            (SELECT COUNT(*) FROM cases c2
             WHERE c2.assigned_to = u.user_id
               AND c2.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases
     FROM users u
     WHERE u.user_role = 'Analyst' AND u.is_active = 1
     ORDER BY open_cases ASC, u.user_name ASC`,
  );
  if (!analysts.length) return;

  for (const staleCase of staleCases) {
    const analyst = analysts[0];
    const dueAt = addWorkingDays(new Date(), 2);
    const dueAtSql = dueAt.toISOString().slice(0, 19).replace('T', ' ');

    const [updateResult] = await database.execute(
      `UPDATE cases
       SET assigned_to = ?, status = 'Under Review', due_at = COALESCE(due_at, ?), updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ? AND assigned_to IS NULL`,
      [analyst.user_id, dueAtSql, staleCase.case_id],
    );
    if (updateResult.affectedRows === 0) continue; // claimed manually in the meantime

    analyst.open_cases += 1;
    analysts.sort((a, b) => a.open_cases - b.open_cases || a.user_name.localeCompare(b.user_name));

    const auditMessage = `Case auto-assigned to ${analyst.user_name} after sitting unassigned for over ${STALE_CASE_MINUTES} minutes.`;
    await database.execute(
      `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NOW())`,
      [id('AUD'), staleCase.transaction_id, 'Case', staleCase.case_id, 'Case Auto-Assigned', auditMessage],
    );
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

  const [cases] = await database.query(
    `SELECT case_id, created_at FROM cases
     WHERE due_at IS NULL
       AND status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')`,
  );
  if (!cases.length) return;

  for (const caseRow of cases) {
    const dueAt = formatSqlDateTime(addWorkingDays(new Date(caseRow.created_at), 2));
    await database.execute(
      'UPDATE cases SET due_at = ? WHERE case_id = ? AND due_at IS NULL',
      [dueAt, caseRow.case_id],
    );
  }
}

async function loadRoleCaseContext(transactionId) {
  await ensureStrWorkflowSchema();
  const [rows] = await database.query(
    `SELECT t.*, m.merchant_name,
            c.case_id, c.assigned_to, c.assigned_role, c.escalation_destination, c.status AS case_status,
            c.due_at, c.referred_to_stro_at, c.referred_to_stro_by,
            sr.str_id, sr.str_status, sr.reference_number, sr.reporting_reason, sr.suspicion_summary,
            sr.transaction_summary, sr.supporting_evidence, sr.stro_notes, sr.referral_reason,
            sr.referral_summary, sr.senior_analyst_notes, sr.prepared_by,
            sr.filed_by, sr.filing_date, sr.filed_at, sr.not_required_reason
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

function isResolvedCaseStatus(status) {
  return ['Resolved', 'Dismissed as False Positive', 'STR Filed'].includes(status);
}

async function auditCaseAction({ transactionId, caseId, action, userId, notes }) {
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [id('AUD'), transactionId, 'Case', caseId, action, userId, notes],
  );
}

async function referToStro(req, res) {
  if (req.session.user.role !== 'Senior Analyst') return forbidJson(res);

  const context = await loadRoleCaseContext(req.params.id);
  if (!context || !context.case_id) {
    return res.status(404).json({ success: false, message: 'Transaction or linked case not found.' });
  }
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be referred to STRO.' });
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
  await database.execute(
    `UPDATE cases
     SET status = 'Escalated',
         assigned_role = 'STRO',
         escalation_destination = 'STRO',
         assigned_to = NULL,
         referred_to_stro_at = ?,
         referred_to_stro_by = ?,
         last_actioned_by = ?,
         last_actioned_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [formatSqlDateTime(now), req.session.user.id, req.session.user.id, formatSqlDateTime(now), context.case_id],
  );
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())`,
    [
      id('STR'),
      context.transaction_id,
      context.case_id,
      referralReason,
      referralSummary,
      JSON.stringify(supportingEvidence),
      seniorAnalystNotes,
    ],
  );
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
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be escalated.' });
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
    await database.execute(
      `UPDATE cases
       SET status = 'Pending Senior Review',
           assigned_role = 'Senior Analyst',
           escalation_destination = 'Senior Analyst',
           assigned_to = NULL,
           notes = COALESCE(?, notes),
           last_actioned_by = ?,
           last_actioned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [notes, req.session.user.id, context.case_id],
    );
    await database.execute(
      "UPDATE transactions SET action_status = 'Pending Senior Review', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
      [context.transaction_id],
    );
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
  await database.execute(
    `UPDATE cases
     SET status = 'Escalated',
         assigned_role = 'STRO',
         escalation_destination = 'STRO',
         assigned_to = NULL,
         referred_to_stro_at = ?,
         referred_to_stro_by = ?,
         notes = COALESCE(?, notes),
         last_actioned_by = ?,
         last_actioned_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [escalatedAtSql, req.session.user.id, notes, req.session.user.id, escalatedAtSql, context.case_id],
  );
  await database.execute(
    "UPDATE transactions SET action_status = 'Escalated', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
    [context.transaction_id],
  );
  await database.execute(
    `INSERT INTO str_reports (
      str_id, transaction_id, case_id, str_status, referral_reason, referral_summary,
      supporting_evidence, senior_analyst_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'Recommended', ?, ?, ?, ?, NOW(), NOW())`,
    [
      id('STR'),
      context.transaction_id,
      context.case_id,
      reason,
      notes,
      JSON.stringify(['Transaction behaviour']),
      notes,
    ],
  );
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
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be updated for STR.' });
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

  await database.execute(
    `UPDATE str_reports
     SET str_status = ?, reference_number = ?, reporting_reason = ?, suspicion_summary = ?,
         transaction_summary = ?, supporting_evidence = ?, stro_notes = ?, prepared_by = ?,
         filed_by = ?, filing_date = ?, filed_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [
      nextStatus,
      referenceNumber || context.reference_number || null,
      reportingReason,
      suspicionSummary,
      transactionSummary,
      JSON.stringify(supportingEvidence),
      stroNotes,
      preparedBy,
      filedBy,
      filingDate || context.filing_date || null,
      filedAt,
      context.case_id,
    ],
  );
  if (nextStatus === 'Filed') {
    await ensureDatabaseResolveColumns();
    const resolvedAtSql = new Date();
    const finalRiskScore = context.final_risk_score ?? context.risk_score;
    const finalRiskLevel = context.final_risk_level || context.risk_level;
    await database.execute(
      `UPDATE cases
       SET status = 'STR Filed', decision = 'Escalated', resolution_reason = 'STR Filed',
           resolved_at = ?, resolved_by = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [resolvedAtSql, req.session.user.id, req.session.user.id, context.case_id],
    );
    await database.execute(
      `UPDATE transactions
       SET action_status = 'STR Filed', final_risk_score = ?, final_risk_level = ?, updated_at = CURRENT_TIMESTAMP
       WHERE transaction_id = ?`,
      [finalRiskScore, finalRiskLevel, context.transaction_id],
    );
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
  if (isResolvedCaseStatus(context.case_status)) {
    return res.status(409).json({ success: false, message: 'Resolved cases cannot be updated for STR.' });
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

  await database.execute(
    `UPDATE str_reports
     SET str_status = 'Not Required', not_required_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE case_id = ?`,
    [reason, context.case_id],
  );
  await database.execute(
    'UPDATE cases SET last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?',
    [req.session.user.id, context.case_id],
  );
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
    const [merchantRows] = await database.query(
      'SELECT merchant_mid, merchant_country, risk_tier, mcc_risk_score FROM merchants WHERE merchant_id = ?',
      [req.body.merchantId],
    );
    const merchant = merchantRows[0]
      ? {
        merchantMid: merchantRows[0].merchant_mid,
        merchantCountry: merchantRows[0].merchant_country,
        riskTier: merchantRows[0].risk_tier,
        mccRiskScore: merchantRows[0].mcc_risk_score,
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
      transactionType: req.body.transactionType || 'sale',
      entryMode: req.body.entryMode || 'manual',
      status: req.body.status || 'captured',
      statusLabel: req.body.statusLabel || 'Captured',
      statusTone: req.body.statusTone || 'success',
      net: req.body.net ?? amount,
      fee: req.body.fee ?? 0,
      txnTime: req.body.txnTime ? new Date(req.body.txnTime) : new Date(),
      note: req.body.note || null,
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
    const result = await fetchLatestRfiResponse({ transactionId });
    return res.status(200).json({
      success: true,
      transactionId,
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

// Which fieldKey a role may set - an Analyst is deliberately missing 'enhancedVerification'
// and 'seniorSignoff', so this endpoint can never be the way an Analyst grants themselves the
// sign-off resolveWorkflow.js's cddGateRequirement checks for. See eddChecklist.js.
const EDD_CHECKLIST_ROLE_FIELDS = {
  Analyst: ['sourceOfFunds', 'siteVisit'],
  'Senior Analyst': ['sourceOfFunds', 'siteVisit', 'enhancedVerification', 'seniorSignoff'],
  Admin: ['sourceOfFunds', 'siteVisit', 'enhancedVerification', 'seniorSignoff'],
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
  const [transactionRows] = await database.query('SELECT merchant_id FROM transactions WHERE transaction_id = ? LIMIT 1', [req.params.id]);
  const merchantId = transactionRows[0]?.merchant_id;
  if (!merchantId) return res.status(404).json({ success: false, message: 'Transaction not found' });

  await setEddChecklistField(database, {
    merchantId, fieldKey, completed, notes: notes || null, userId: currentUser.id,
  });
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'), req.params.id, 'Merchant', merchantId, 'Merchant EDD Checklist Updated', currentUser.id,
      `${fieldKey} set to ${completed ? 'complete' : 'incomplete'} by ${currentUser.name} (${currentUser.role}).`,
    ],
  );

  return res.status(200).json({ success: true, fieldKey, completed });
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
  const [caseRows] = await database.query(
    'SELECT case_id FROM cases WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1',
    [transactionId],
  );
  const caseId = caseRows[0]?.case_id;
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
  await database.execute(
    `INSERT INTO case_rfi_evidence (evidence_id, case_id, transaction_id, evidence_type, description, mailbox_reference, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [evidenceId, caseId, transactionId, evidenceType, description, mailboxReference, currentUser.id],
  );
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'), transactionId, 'Case', caseId, 'RFI Evidence Logged', currentUser.id,
      `${evidenceType}: ${description}${mailboxReference ? ` (${mailboxReference})` : ''}`,
    ],
  );

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
  logRfiEvidence,
  apiNotFound,
};
