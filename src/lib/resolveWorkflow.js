const database = require('../database');
const { id } = require('./ids');
const { ensureDatabaseResolveColumns } = require('./schema');
const { parseFinalRiskScore, getRiskLevelFromScore, hasMeaningfulAnalystNotes } = require('./strDraft');
const { assessmentDecisions, resolutionReasons } = require('../constants');
const { roleCanPerform, forbidJson } = require('../middleware/auth');

async function handleDatabaseResolveRequest(req, res) {
  if (!req.session?.user || !roleCanPerform(req.session.user.role, 'resolveCase')) {
    return forbidJson(res);
  }

  let rows;
  try {
    await ensureDatabaseResolveColumns();
    [rows] = await database.query(
      `SELECT t.transaction_id, t.risk_score, t.risk_level, t.status, t.action_status,
              t.final_risk_score, t.final_risk_level,
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
       SET status = ?, decision = ?, resolution_reason = ?, analyst_notes = ?, resolved_at = ?, resolved_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE case_id = ?`,
      [nextStatus, decision, resolutionReason, analystNotes, resolvedAtSql, req.session.user.id, row.case_id],
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
    } : null,
  });
}

module.exports = { handleDatabaseResolveRequest };
