const { strEvidenceOptions, strEvidenceRuleTypeGroups } = require('../constants');

function getRiskLevelFromScore(score) {
  if (score >= 70) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function parseFinalRiskScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  return score;
}

function addWorkingDays(startDate, days) {
  const result = new Date(startDate);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }

  return result;
}

function hasMeaningfulAnalystNotes(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 10) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
}

function hasMeaningfulText(value, minLength) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < minLength) return false;
  return !['test', 'testing', 'n/a', 'na'].includes(normalized.toLowerCase());
}

function normalizeEvidence(value) {
  const items = Array.isArray(value) ? value : [value].filter(Boolean);
  return items
    .map((item) => String(item || '').trim())
    .filter((item) => strEvidenceOptions.includes(item));
}

function formatSqlDateTime(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

function buildTransactionSummary(transaction) {
  return [
    `Transaction ID: ${transaction.transaction_id || transaction.id || ''}`,
    `Transaction date: ${transaction.created_at || transaction.createdAt ? new Date(transaction.created_at || transaction.createdAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) : 'Not assigned'}`,
    `Amount: ${transaction.currency || 'SGD'} ${Number(transaction.amount || 0).toFixed(2)}`,
    `Direction: ${transaction.direction || 'Local card payment'}`,
    `Counterparty: ${transaction.counterparty || transaction.counterpartyName || transaction.merchant_name || transaction.companyName || 'Merchant'}`,
    `Counterparty country: ${transaction.counterparty_country || transaction.counterpartyCountry || 'Singapore'}`,
  ].join('\n');
}

function summarizeMatchedRules(matchedRules) {
  return (matchedRules || [])
    .filter((rule) => rule.rule_name)
    .map((rule) => `${rule.rule_name} (${rule.risk_level || 'Unknown'} risk, weight ${rule.weight ?? 0}) — ${rule.reason || 'No reason recorded'}`)
    .join('; ');
}

function buildStrReferenceNumber(transactionId) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `STR-${transactionId || 'TXN'}-${stamp}`;
}

function buildStrEvidenceSuggestions({ matchedRules, transaction, activityLogs }) {
  const evidence = new Set();
  const ruleTypes = new Set((matchedRules || []).map((rule) => rule.rule_type));
  if ((matchedRules || []).length) evidence.add('Triggered monitoring rules');
  Object.entries(strEvidenceRuleTypeGroups).forEach(([evidenceLabel, types]) => {
    if (types.some((type) => ruleTypes.has(type))) evidence.add(evidenceLabel);
  });
  if (Number(transaction?.mcc_risk_score || 0) > 0) evidence.add('Merchant profile risk');
  if ((activityLogs || []).some((entry) => /information (requested|sent)|rfi/i.test(entry.action || ''))) evidence.add('RFI response');
  return Array.from(evidence);
}

function buildStrDraftReportingReason(transaction, caseRecord, matchedRules) {
  const riskLevel = transaction?.risk_level || 'Unknown';
  const riskScore = transaction?.risk_score ?? 'unknown';
  const ruleNames = (matchedRules || []).map((rule) => rule.rule_name).filter(Boolean);
  const sentences = [
    `Transaction ${transaction?.transaction_id || ''} is being reported for suspicious activity after triggering ${ruleNames.length} monitoring rule${ruleNames.length === 1 ? '' : 's'}${ruleNames.length ? ` (${ruleNames.join(', ')})` : ''}, resulting in a ${riskLevel} risk classification (score: ${riskScore}).`,
  ];
  if (caseRecord?.referral_reason) {
    sentences.push(`The case was referred to STRO for review because: ${caseRecord.referral_reason}.`);
  }
  return sentences.join(' ');
}

function buildStrDraftSuspicionSummary(transaction, caseRecord, matchedRules) {
  const amount = Number(transaction?.amount || 0).toFixed(2);
  const currency = transaction?.currency || 'SGD';
  const merchantName = transaction?.merchant_name || 'the merchant';
  const createdAt = transaction?.created_at ? new Date(transaction.created_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) : 'an unrecorded date';
  const ruleSummary = summarizeMatchedRules(matchedRules);
  const parts = [
    `On ${createdAt}, a transaction of ${currency} ${amount} was processed with ${merchantName} (transaction ID ${transaction?.transaction_id || ''}).`,
  ];
  if (ruleSummary) parts.push(`The transaction triggered the following monitoring rule(s): ${ruleSummary}.`);
  if (caseRecord?.referral_summary) parts.push(`Senior Analyst referral summary: ${caseRecord.referral_summary}`);
  if (caseRecord?.senior_analyst_notes) parts.push(`Senior Analyst notes: ${caseRecord.senior_analyst_notes}`);
  parts.push('Based on the above, this activity is assessed as warranting a suspicious transaction report for further review by the reporting officer.');
  return parts.join(' ');
}

function buildStrDraftStroNotes(transaction, matchedRules) {
  const ruleCount = (matchedRules || []).length;
  return [
    `Reviewed transaction ${transaction?.transaction_id || ''} and associated case history prior to STR preparation.`,
    ruleCount
      ? `Confirmed ${ruleCount} monitoring rule match${ruleCount === 1 ? '' : 'es'} supporting the suspicion basis.`
      : 'No monitoring rules were recorded for this transaction; suspicion basis derived from case referral.',
    'This is a system-generated draft — review and amend before submission.',
  ].join(' ');
}

function buildStrAutoFill({ transaction, caseRecord, matchedRules, activityLogs }) {
  return {
    referenceNumber: buildStrReferenceNumber(transaction?.transaction_id),
    filingDate: new Date().toISOString().slice(0, 10),
    reportingReason: buildStrDraftReportingReason(transaction, caseRecord, matchedRules),
    suspicionSummary: buildStrDraftSuspicionSummary(transaction, caseRecord, matchedRules),
    stroNotes: buildStrDraftStroNotes(transaction, matchedRules),
    supportingEvidence: buildStrEvidenceSuggestions({ matchedRules, transaction, activityLogs }),
  };
}

module.exports = {
  getRiskLevelFromScore,
  parseFinalRiskScore,
  addWorkingDays,
  hasMeaningfulAnalystNotes,
  hasMeaningfulText,
  normalizeEvidence,
  formatSqlDateTime,
  buildTransactionSummary,
  buildStrAutoFill,
};
