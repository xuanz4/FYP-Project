// Single entry point for getting a partner-shaped transaction into the system, used by both
// the historical import (scripts/importTestData.js) and live ingestion (POST /api/transactions).
// The transactions_auto_case_insert DB trigger opens a case automatically once status is
// written as 'Flagged' - this module never opens cases itself.
const { evaluateTransaction } = require('./riskEngine');
const { ensureRiskAndContactSchema } = require('./lib/schema');
const { upsertMerchantRiskProfile, generateUniqueTransactionReference } = require('./lib/merchantRiskProfile');
const { loadMerchantCddContext } = require('./lib/merchantCdd');
const merchantModel = require('../models/merchantModel');
const transactionModel = require('../models/transactionModel');
const matchedRuleModel = require('../models/matchedRuleModel');

async function ensureMerchant(database, merchant) {
  await merchantModel.upsertFromPartnerFeed(database, {
    merchantId: merchant.merchantId,
    merchantName: merchant.merchantName,
    merchantMid: merchant.merchantMid || null,
    merchantCountry: merchant.merchantCountry || null,
    authorisedContactName: merchant.authorisedContactName || null,
    authorisedContactEmail: merchant.authorisedContactEmail || null,
    mccCode: merchant.mccCode || '0000',
    industry: merchant.industry || 'Unclassified',
    mccRiskScore: merchant.mccRiskScore || 0,
    riskTier: merchant.riskTier || 'Standard',
  });
}

// raw: { id, merchantId, storeId, amount, method, scheme, issuer, issuerBank, cardBin,
//        cardLast4, cardRef, cvvValidationResult, expiryValidationResult, transactionCode,
//        transactionType, entryMode, status, statusLabel, statusTone, net, fee, txnTime, note }
// cardRef is an optional tokenised/hashed card reference from the partner feed (never a raw
// PAN) - present only once the partner adds it; absent transactions just don't get matched
// against other cards.
// merchant: { merchantMid, merchantCountry, riskTier, mccRiskScore } - looked up by the caller
// so we don't re-query per row.
async function ingestTransaction(database, raw, merchant, { broadcast } = {}) {
  await ensureRiskAndContactSchema();

  const txnTime = raw.txnTime instanceof Date ? raw.txnTime : new Date(raw.txnTime);
  // The checklist is per-transaction (see merchantCdd.js) - passing raw.id here means a new
  // transaction never inherits an "EDD complete" checklist from a prior transaction of the same
  // merchant; it always starts with no checklist row until an analyst creates one for this case.
  const cddContext = await loadMerchantCddContext(database, raw.merchantId, { transactionId: raw.id });

  const evaluation = await evaluateTransaction({
    txn: {
      merchantId: raw.merchantId,
      merchantMid: merchant.merchantMid || null,
      merchantCountry: merchant.merchantCountry,
      merchantRiskTier: merchant.riskTier || 'Standard',
      mccRiskScore: merchant.mccRiskScore || 0,
      storeId: raw.storeId,
      amount: Number(raw.amount),
      issuerCountry: raw.issuer,
      cardRef: raw.cardRef || null,
      cvvValidationResult: raw.cvvValidationResult || null,
      expiryValidationResult: raw.expiryValidationResult || null,
      txnTime,
      merchantExpectedAvgTicket: cddContext.expectedAvgTicket,
      merchantExpectedOperatingHours: cddContext.expectedOperatingHours,
      merchantExpectedCountries: cddContext.expectedCountries,
      merchantCddReviewOverdue: cddContext.reviewOverdue,
      merchantEddComplete: cddContext.eddComplete,
    },
    database,
  });

  const uniqueTransactionReference = await generateUniqueTransactionReference(database, txnTime);

  await transactionModel.insertIngested(database, {
    transactionId: raw.id,
    uniqueTransactionReference,
    merchantId: raw.merchantId,
    storeId: raw.storeId || null,
    amount: raw.amount,
    method: raw.method || null,
    scheme: raw.scheme || null,
    issuerCountry: raw.issuer || null,
    issuerBank: raw.issuerBank || null,
    cardBin: /^\d{6,8}$/.test(String(raw.cardBin || '')) ? String(raw.cardBin) : null,
    cardLast4: /^\d{4}$/.test(String(raw.cardLast4 || '')) ? String(raw.cardLast4) : null,
    cvvValidationResult: raw.cvvValidationResult || null,
    expiryValidationResult: raw.expiryValidationResult || null,
    transactionCode: raw.transactionCode || null,
    transactionType: raw.transactionType || null,
    entryMode: raw.entryMode || null,
    paymentStatus: raw.status || null,
    paymentStatusLabel: raw.statusLabel || null,
    paymentStatusTone: raw.statusTone || null,
    net: raw.net ?? null,
    fee: raw.fee ?? null,
    txnTime,
    sourceNote: raw.note || null,
    riskScore: evaluation.riskScore,
    riskLevel: evaluation.riskLevel,
    mccRiskContribution: evaluation.mccRiskContribution,
    profileRiskContribution: evaluation.profileRiskContribution,
    transactionDetectionContribution: evaluation.detectionContribution,
    status: evaluation.status,
    cardRef: raw.cardRef || null,
  });

  for (const rule of evaluation.matchedRules) {
    // eslint-disable-next-line no-await-in-loop
    await matchedRuleModel.recordMatch(database, raw.id, rule.id);
  }

  // Recomputed after this transaction is committed, from history strictly up to and including
  // it, so the *next* transaction's profileRiskContribution reflects this one - never itself.
  await upsertMerchantRiskProfile(database, raw.merchantId);

  if (broadcast) {
    broadcast('transaction', {
      transactionId: raw.id,
      uniqueTransactionReference,
      merchantId: raw.merchantId,
      amount: raw.amount,
      riskLevel: evaluation.riskLevel,
      status: evaluation.status,
    });
  }

  return { ...evaluation, uniqueTransactionReference };
}

module.exports = { ensureMerchant, ingestTransaction };
