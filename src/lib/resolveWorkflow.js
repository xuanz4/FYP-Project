const database = require('../database');
const { id } = require('./ids');
const { ensureDatabaseResolveColumns, ensureRiskAndContactSchema, ensureCaseAssignmentColumns } = require('./schema');
const { parseFinalRiskScore, getRiskLevelFromScore, hasMeaningfulAnalystNotes } = require('./strDraft');
const { assessmentDecisions, resolutionReasons } = require('../constants');
const { roleCanPerform, forbidJson } = require('../middleware/auth');
const { loadMerchantCddContext } = require('./merchantCdd');
const transactionModel = require('../../models/transactionModel');
const caseModel = require('../../models/caseModel');
const auditLogModel = require('../../models/auditLogModel');

// Whole number 0-100, required - used for the mandatory manual reconciliation fields. Distinct
// from parseFinalRiskScore only in name, kept separate since "final risk score" and "manual
// reconciliation entry" are conceptually different fields that happen to share a shape.
function parseRequiredWholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) return null;
  return number;
}

function calculateFinalScoreFromContributions(mccContribution, profileContribution, detectionContribution) {
  return Math.min(100, Number(mccContribution || 0) + Number(profileContribution || 0) + Number(detectionContribution || 0));
}

// EDD completion requires senior_signoff_completed specifically (see merchantCdd.js's
// computeEddComplete) - an Analyst can record the two Analyst-settable checklist items but
// can never grant sign-off themselves, so this gate can't be satisfied by one role alone.
function cddGateRequirement({ role, cddContext }) {
  const reasons = [];
  if (!cddContext.cddComplete) reasons.push('CDD is incomplete');
  if (cddContext.reviewOverdue) reasons.push('the CDD review date has passed');
  if (cddContext.eddRequired) {
    if (!cddContext.eddComplete) reasons.push('this merchant\'s EDD checklist is incomplete (Senior Analyst sign-off outstanding)');
  }
  if (!reasons.length) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    message: `Resolution is blocked: ${reasons.join('; ')}.`,
  };
}

function reviewRequirementForScoreChange({ role, automatedScore, manualFinalScore, analystNotes }) {
  const originalScore = Number(automatedScore ?? 0);
  const finalScore = Number(manualFinalScore ?? 0);
  const originalLevel = getRiskLevelFromScore(originalScore);
  const finalLevel = getRiskLevelFromScore(finalScore);
  const riskOrder = { Low: 1, Medium: 2, High: 3, Critical: 4 };
  const loweredRiskBand = riskOrder[finalLevel] < riskOrder[originalLevel];
  const criticalLoweredToLowOrMedium = originalLevel === 'Critical' && ['Low', 'Medium'].includes(finalLevel);
  const pointDifference = Math.abs(finalScore - originalScore);
  const largePointDifference = pointDifference >= 20;
  const detailedNotesProvided = String(analystNotes || '').trim().replace(/\s+/g, ' ').length >= 30;

  if ((loweredRiskBand || criticalLoweredToLowOrMedium) && role !== 'Senior Analyst') {
    return {
      allowed: false,
      status: 403,
      message: 'Lowering the risk band requires Senior Analyst approval.',
    };
  }
  if (largePointDifference && !detailedNotesProvided) {
    return {
      allowed: false,
      status: 400,
      message: 'Large final-score changes require a detailed justification of at least 30 characters.',
    };
  }

  return {
    allowed: true,
    originalScore,
    finalScore,
    originalLevel,
    finalLevel,
    pointDifference,
    loweredRiskBand,
    largePointDifference,
  };
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

  let row;
  try {
    await ensureDatabaseResolveColumns();
    await ensureRiskAndContactSchema();
    await ensureCaseAssignmentColumns();
    row = await transactionModel.findResolveContextByTransactionId(req.params.id);
  } catch (error) {
    console.error('Unable to load database resolve context', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to load transaction details' });
  }

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

  const cddContext = await loadMerchantCddContext(database, row.merchant_id, {
    transactionRiskLevel: row.risk_level,
    transactionId: row.transaction_id,
  });
  const cddGate = cddGateRequirement({ role: req.session.user.role, cddContext });
  if (!cddGate.allowed) {
    return res.status(cddGate.status).json({ success: false, message: cddGate.message });
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
  if ([manualMccContribution, manualProfileContribution, manualDetectionContribution].some((value) => value === null)) {
    return res.status(400).json({
      success: false,
      message: 'Manual MCC, Profile and Detection contributions are all required whole numbers from 0 to 100.',
    });
  }
  const manualFinalScore = calculateFinalScoreFromContributions(
    manualMccContribution,
    manualProfileContribution,
    manualDetectionContribution,
  );
  if (finalRiskScore !== manualFinalScore) {
    return res.status(400).json({
      success: false,
      message: `Final risk score must equal min(100, MCC + Profile + Detection). Expected ${manualFinalScore}.`,
    });
  }
  const reviewRequirement = reviewRequirementForScoreChange({
    role: req.session.user.role,
    automatedScore: row.risk_score,
    manualFinalScore,
    analystNotes,
  });
  if (!reviewRequirement.allowed) {
    return res.status(reviewRequirement.status).json({ success: false, message: reviewRequirement.message });
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

  await transactionModel.markResolved(row.transaction_id, {
    finalRiskScore, finalRiskLevel, actionStatus: nextStatus,
  });
  if (row.case_id) {
    await caseModel.resolveCase({
      caseId: row.case_id,
      status: nextStatus,
      decision,
      resolutionReason,
      analystNotes,
      resolvedAt: resolvedAtSql,
      resolvedBy: req.session.user.id,
      manualMccContribution,
      manualProfileContribution,
      manualDetectionContribution,
      manualFinalScore,
      discrepancyFlag,
      discrepancyNotes,
    });
  }
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId: row.transaction_id,
    action: 'Final Risk Assigned',
    userId: req.session.user.id,
    notes: `Final risk assigned as ${finalRiskLevel} with score ${finalRiskScore}.`,
  });
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId: row.transaction_id,
    action: 'Assessment Resolved',
    userId: req.session.user.id,
    notes: `Assessment resolved with decision ${decision} and reason ${resolutionReason}.`,
  });
  // Written every time, match or mismatch, so there is a permanent record that reconciliation
  // was performed on every resolved case - not just the ones that found a problem.
  await auditLogModel.insert({
    auditId: id('AUD'),
    transactionId: row.transaction_id,
    action: 'Manual Reconciliation Performed',
    userId: req.session.user.id,
    notes: discrepancyFlag
      ? `Manual reconciliation performed - DISCREPANCY: ${discrepancyNotes} (reference ${row.unique_transaction_reference || row.transaction_id}).`
      : `Manual reconciliation performed - values matched (reference ${row.unique_transaction_reference || row.transaction_id}).`,
  });

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

module.exports = {
  handleDatabaseResolveRequest,
  parseRequiredWholeNumber,
  calculateFinalScoreFromContributions,
  reviewRequirementForScoreChange,
  buildReconciliationResult,
  cddGateRequirement,
};
