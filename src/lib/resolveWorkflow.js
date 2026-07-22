const database = require('../database');
const { id } = require('./ids');
const { ensureDatabaseResolveColumns, ensureRiskAndContactSchema, ensureCaseAssignmentColumns } = require('./schema');
const { parseFinalRiskScore, getRiskLevelFromScore, hasMeaningfulAnalystNotes } = require('./strDraft');
const { assessmentDecisions, resolutionReasons } = require('../constants');
const { roleCanPerform, forbidJson } = require('../middleware/auth');

// Whole number 0-100, required - used for the mandatory manual reconciliation fields. Distinct
// from parseFinalRiskScore only in name, kept separate since "final risk score" and "manual
// reconciliation entry" are conceptually different fields that happen to share a shape.
function parseRequiredWholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) return null;
  return number;
}

// Pure comparison between what the system actually calculated and what the resolver manually
// entered - kept side-effect-free so it's unit-testable without a database.
function buildReconciliationResult({
  actualMccContribution, actualProfileContribution, actualDetectionContribution, actualScore,
  manualMccContribution, manualProfileContribution, manualDetectionContribution, manualFinalScore,
}) {
  const mismatches = [
    ['MCC', actualMccContribution ?? 0, manualMccContribution],
    ['Profile', actualProfileContribution ?? 0, manualProfileContribution],
    ['Detection', actualDetectionContribution ?? 0, manualDetectionContribution],
    ['Final', actualScore ?? 0, manualFinalScore],
  ].filter(([, actual, manual]) => Number(actual) !== Number(manual));
  const discrepancyFlag = mismatches.length > 0;
  const discrepancyNotes = discrepancyFlag
    ? mismatches.map(([label, actual, manual]) => `${label}: expected ${actual}, entered ${manual}`).join('; ')
    : 'Manual entry matched the automated calculation for all contributions and final score.';
  return { discrepancyFlag, discrepancyNotes, mismatches };
}

async function handleDatabaseResolveRequest(req, res) {
  if (!req.session?.user || !roleCanPerform(req.session.user.role, 'resolveCase')) {
    return forbidJson(res);
  }

  let rows;
  try {
    await ensureDatabaseResolveColumns();
    await ensureRiskAndContactSchema();
    await ensureCaseAssignmentColumns();
    [rows] = await database.query(
      `SELECT t.transaction_id, t.unique_transaction_reference, t.risk_score, t.risk_level, t.status, t.action_status,
              t.final_risk_score, t.final_risk_level,
              t.mcc_risk_contribution, t.profile_risk_contribution, t.transaction_detection_contribution,
              c.case_id, c.status AS case_status, c.resolved_at
       FROM transactions t
       LEFT JOIN cases c ON c.transaction_id = t.transaction_id
       WHERE t.transaction_id = ?
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [req.params.id],
    );
  } catch (error) {
    console.error('Unable to load database resolve context', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to load transaction details' });
  }

  const row = rows[0];
  if (!row) return res.status(404).json({ success: false, message: 'Transaction not found' });

  const currentStatus = row.case_status || row.action_status || 'Open';
  if (req.session.user.role === 'Analyst' && (currentStatus === 'Escalated' || currentStatus === 'Pending Senior Review' || row.risk_level === 'Critical')) {
    return forbidJson(res);
  }
  if (row.final_risk_score !== null && row.final_risk_score !== undefined && row.final_risk_level) {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }
  if (row.resolved_at || currentStatus === 'Resolved') {
    return res.status(409).json({ success: false, message: 'Assessment already resolved' });
  }

  const finalRiskScore = parseFinalRiskScore(req.body.finalRiskScore);
  if (finalRiskScore === null) {
    return res.status(400).json({ success: false, message: 'Final risk score must be a whole number from 0 to 100' });
  }
  const finalRiskLevel = getRiskLevelFromScore(finalRiskScore);
  const decision = req.body.decision;
  const resolutionReason = String(req.body.resolutionReason || '').trim();
  const analystNotes = String(req.body.analystNotes || '').trim();
  if (!assessmentDecisions.includes(decision)) {
    return res.status(400).json({ success: false, message: 'Invalid decision' });
  }
  if (!resolutionReason || !resolutionReasons.includes(resolutionReason)) {
    return res.status(400).json({ success: false, message: 'Resolution reason is required' });
  }
  if (!hasMeaningfulAnalystNotes(analystNotes)) {
    return res.status(400).json({ success: false, message: 'Please provide a meaningful explanation of at least 10 characters.' });
  }
  if (resolutionReason === 'False Positive' && decision !== 'Accepted') {
    return res.status(400).json({ success: false, message: 'False Positive resolutions must use the Accepted decision' });
  }

  // Mandatory manual reconciliation: the resolver must key in the component values before a case can
  // be resolved - no partial/silent resolution. The cases columns themselves stay nullable at
  // the DB level (an unresolved case legitimately has nothing there yet); this is the gate.
  const manualMccContribution = parseRequiredWholeNumber(req.body.manualMccContribution);
  const manualProfileContribution = parseRequiredWholeNumber(req.body.manualProfileContribution);
  const manualDetectionContribution = parseRequiredWholeNumber(req.body.manualDetectionContribution);
  const manualFinalScore = finalRiskScore;
  if ([manualMccContribution, manualProfileContribution, manualDetectionContribution].some((value) => value === null)) {
    return res.status(400).json({
      success: false,
      message: 'Manual MCC, Profile and Detection contributions are all required whole numbers from 0 to 100.',
    });
  }

  const { discrepancyFlag, discrepancyNotes } = buildReconciliationResult({
    actualMccContribution: row.mcc_risk_contribution,
    actualProfileContribution: row.profile_risk_contribution,
    actualDetectionContribution: row.transaction_detection_contribution,
    actualScore: row.risk_score,
    manualMccContribution,
    manualProfileContribution,
    manualDetectionContribution,
    manualFinalScore,
  });

  const resolvedAtSql = new Date();
  const nextStatus = 'Resolved';

  await database.execute(
    `UPDATE transactions
     SET final_risk_score = ?, final_risk_level = ?, action_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = ?`,
    [finalRiskScore, finalRiskLevel, nextStatus, row.transaction_id],
  );
  if (row.case_id) {
    await database.execute(
      `UPDATE cases
       SET status = ?, decision = ?, resolution_reason = ?, analyst_notes = ?, resolved_at = ?, resolved_by = ?,
           manual_mcc_contribution = ?, manual_profile_contribution = ?, manual_detection_contribution = ?, manual_final_score = ?,
           discrepancy_flag = ?, discrepancy_notes = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [
        nextStatus, decision, resolutionReason, analystNotes, resolvedAtSql, req.session.user.id,
        manualMccContribution, manualProfileContribution, manualDetectionContribution, manualFinalScore,
        discrepancyFlag ? 1 : 0, discrepancyNotes, req.session.user.id, row.case_id,
      ],
    );
  }
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'),
      row.transaction_id,
      'Final Risk Assigned',
      req.session.user.id,
      `Final risk assigned as ${finalRiskLevel} with score ${finalRiskScore}.`,
    ],
  );
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'),
      row.transaction_id,
      'Assessment Resolved',
      req.session.user.id,
      `Assessment resolved with decision ${decision} and reason ${resolutionReason}.`,
    ],
  );
  // Written every time, match or mismatch, so there is a permanent record that reconciliation
  // was performed on every resolved case - not just the ones that found a problem.
  await database.execute(
    `INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      id('AUD'),
      row.transaction_id,
      'Manual Reconciliation Performed',
      req.session.user.id,
      discrepancyFlag
        ? `Manual reconciliation performed - DISCREPANCY: ${discrepancyNotes} (reference ${row.unique_transaction_reference || row.transaction_id}).`
        : `Manual reconciliation performed - values matched (reference ${row.unique_transaction_reference || row.transaction_id}).`,
    ],
  );

  return res.status(200).json({
    success: true,
    message: 'Assessment resolved successfully',
    transaction: {
      transaction_id: row.transaction_id,
      risk_score: row.risk_score,
      risk_level: row.risk_level,
      finalRiskScore,
      finalRiskLevel,
      decision,
      resolutionReason,
      analystNotes,
      resolvedAt: resolvedAtSql ? resolvedAtSql.toISOString() : null,
    },
    case: row.case_id ? {
      case_id: row.case_id,
      status: nextStatus,
      decision,
      resolutionReason,
      analystNotes,
      resolvedAt: resolvedAtSql ? resolvedAtSql.toISOString() : null,
      discrepancyFlag,
      discrepancyNotes,
    } : null,
  });
}

module.exports = { handleDatabaseResolveRequest, parseRequiredWholeNumber, buildReconciliationResult };
