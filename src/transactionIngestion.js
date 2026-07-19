// Single entry point for getting a partner-shaped transaction into the system, used by both
// the historical import (scripts/importTestData.js) and live ingestion (POST /api/transactions).
// The transactions_auto_case_insert DB trigger opens a case automatically once status is
// written as 'Flagged' - this module never opens cases itself.
const { evaluateTransaction } = require('./riskEngine');

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

// raw: { id, merchantId, storeId, amount, method, scheme, issuer, transactionType, entryMode,
//        status, statusLabel, statusTone, net, fee, txnTime, note }
// merchant: { merchantCountry, riskTier } - looked up by the caller so we don't re-query per row.
async function ingestTransaction(database, raw, merchant, { broadcast } = {}) {
  const txnTime = raw.txnTime instanceof Date ? raw.txnTime : new Date(raw.txnTime);

  const evaluation = await evaluateTransaction({
    txn: {
      merchantId: raw.merchantId,
      merchantCountry: merchant.merchantCountry,
      merchantRiskTier: merchant.riskTier || 'Standard',
      storeId: raw.storeId,
      amount: Number(raw.amount),
      issuerCountry: raw.issuer,
      txnTime,
    },
    database,
  });

  await database.execute(
    `INSERT INTO transactions (
      transaction_id, merchant_id, store_id, amount, method, scheme, issuer_country,
      transaction_type, entry_mode, payment_status, payment_status_label, payment_status_tone,
      net, fee, txn_time, source_note, risk_score, risk_level, status, action_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'None', ?)`,
    [
      raw.id, raw.merchantId, raw.storeId || null, raw.amount, raw.method || null, raw.scheme || null, raw.issuer || null,
      raw.transactionType || null, raw.entryMode || null, raw.status || null, raw.statusLabel || null, raw.statusTone || null,
      raw.net ?? null, raw.fee ?? null, txnTime, raw.note || null,
      evaluation.riskScore, evaluation.riskLevel, evaluation.status, txnTime,
    ],
  );

  for (const rule of evaluation.matchedRules) {
    await database.execute(
      `INSERT INTO transaction_matched_rules (transaction_id, rule_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE matched_at = matched_at`,
      [raw.id, rule.id],
    );
  }

  if (broadcast) {
    broadcast('transaction', {
      transactionId: raw.id,
      merchantId: raw.merchantId,
      amount: raw.amount,
      riskLevel: evaluation.riskLevel,
      status: evaluation.status,
    });
  }

  return evaluation;
}

module.exports = { ensureMerchant, ingestTransaction };
