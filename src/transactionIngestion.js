// Single entry point for getting a partner-shaped transaction into the system, used by both
// the historical import (scripts/importTestData.js) and live ingestion (POST /api/transactions).
// The transactions_auto_case_insert DB trigger opens a case automatically once status is
// written as 'Flagged' - this module never opens cases itself.
const { evaluateTransaction } = require('./riskEngine');
const { ensureRiskAndContactSchema } = require('./lib/schema');
const { upsertMerchantRiskProfile, generateUniqueTransactionReference } = require('./lib/merchantRiskProfile');
const { loadMerchantCddContext } = require('./lib/merchantCdd');

async function ensureMerchant(database, merchant) {
  await database.execute(
    `INSERT INTO merchants (merchant_id, merchant_name, merchant_mid, merchant_country, authorised_contact_name, authorised_contact_email, mcc_code, industry, mcc_risk_score, risk_tier, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       merchant_name = VALUES(merchant_name),
       merchant_mid = VALUES(merchant_mid),
       merchant_country = VALUES(merchant_country),
       authorised_contact_name = COALESCE(VALUES(authorised_contact_name), authorised_contact_name),
       authorised_contact_email = COALESCE(VALUES(authorised_contact_email), authorised_contact_email)`,
    [
      merchant.merchantId,
      merchant.merchantName,
      merchant.merchantMid || null,
      merchant.merchantCountry || null,
      merchant.authorisedContactName || null,
      merchant.authorisedContactEmail || null,
      merchant.mccCode || '0000',
      merchant.industry || 'Unclassified',
      merchant.mccRiskScore || 0,
      merchant.riskTier || 'Standard',
    ],
  );
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

  await database.execute(
    `INSERT INTO transactions (
      transaction_id, unique_transaction_reference, merchant_id, store_id, amount, method, scheme, issuer_country,
      issuer_bank, card_bin, card_last4, cvv_validation_result, expiry_validation_result, transaction_code,
      transaction_type, entry_mode, payment_status, payment_status_label, payment_status_tone,
      net, fee, txn_time, source_note, risk_score, risk_level,
      mcc_risk_contribution, profile_risk_contribution, transaction_detection_contribution,
      status, action_status, created_at, card_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'None', ?, ?)`,
    [
      raw.id, uniqueTransactionReference, raw.merchantId, raw.storeId || null, raw.amount, raw.method || null, raw.scheme || null, raw.issuer || null,
      raw.issuerBank || null,
      /^\d{6,8}$/.test(String(raw.cardBin || '')) ? String(raw.cardBin) : null,
      /^\d{4}$/.test(String(raw.cardLast4 || '')) ? String(raw.cardLast4) : null,
      raw.cvvValidationResult || null, raw.expiryValidationResult || null, raw.transactionCode || null,
      raw.transactionType || null, raw.entryMode || null, raw.status || null, raw.statusLabel || null, raw.statusTone || null,
      raw.net ?? null, raw.fee ?? null, txnTime, raw.note || null,
      evaluation.riskScore, evaluation.riskLevel,
      evaluation.mccRiskContribution, evaluation.profileRiskContribution, evaluation.detectionContribution,
      evaluation.status, txnTime, raw.cardRef || null,
    ],
  );

  for (const rule of evaluation.matchedRules) {
    await database.execute(
      `INSERT INTO transaction_matched_rules (transaction_id, rule_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE matched_at = matched_at`,
      [raw.id, rule.id],
    );
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
