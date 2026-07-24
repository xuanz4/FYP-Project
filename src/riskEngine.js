// Risk engine for the partner-shaped merchant/card transaction feed (see
// FYP_Transaction_Monitoring.sql `transactions`/`compliance_rules`/`merchants`).
// Unlike the old in-memory engine, every signal here is computed from the merchant's actual
// recent transaction history in MySQL (via database.query), not randomised placeholders.
// Score is on the same 0-100 scale the rest of the app already uses (see
// app.js getRiskLevelFromScore/parseFinalRiskScore).

const merchantRiskProfileModel = require('../models/merchantRiskProfileModel');
const transactionModel = require('../models/transactionModel');
const complianceRuleModel = require('../models/complianceRuleModel');

const OPERATING_HOURS = { openHour: 7, closeHour: 23 };
const STORE_VELOCITY_WINDOW_MIN = 30;
const CROSS_STORE_VELOCITY_WINDOW_MIN = 30;
const AGGREGATE_WINDOW_HOURS = 24;
const NEAR_THRESHOLD_WINDOW_HOURS = 24;
const FOREIGN_ISSUER_WINDOW_MIN = 60;
const CARD_TESTING_WINDOW_MIN = 10;
const CARD_TESTING_AMOUNT_CEILING = 20;
const CARD_SPEND_WINDOW_HOURS = 24;
const LOW_VALUE_CARD_BURST_WINDOW_MIN = 15;

function riskLevelFromScore(score) {
  if (score >= 70) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function minutesBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

// Profile contribution comes from the merchant's *stored* profile snapshot (built from history
// strictly before this transaction, see transactionIngestion.js's upsertMerchantRiskProfile) -
// never recomputed live here, so a transaction never double-counts itself into its own profile.
async function loadMerchantProfileContribution(database, merchantMid) {
  if (!merchantMid) return 0;
  const profile = await merchantRiskProfileModel.findProfileContributionSnapshot(database, merchantMid);
  if (!profile || Number(profile.transaction_count) < 5) return 0;
  return Number(profile.profile_risk_score) || 0;
}

// One query per incoming transaction: everything else the rules need is derived from this
// merchant-scoped 24h window in memory, so live ingestion and historical replay both stay fast.
async function loadRecentMerchantHistory(database, merchantId, txnTime) {
  const windowStart = new Date(txnTime.getTime() - AGGREGATE_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await transactionModel.findRecentHistoryForMerchant(database, merchantId, windowStart, txnTime);
  return rows.map((row) => ({
    storeId: row.store_id,
    amount: Number(row.amount),
    issuerCountry: row.issuer_country,
    txnTime: new Date(row.txn_time),
    cardRef: row.card_ref || null,
  }));
}

// STR-01 structuring band: count of this merchant's own transactions (in the aggregate window)
// sitting just under `nearThresholdCeiling`, so repeated near-threshold amounts trip it - not
// just one. Ceiling is that merchant's medium amount-spike threshold, passed in by the caller.
function countNearThreshold(history, txn, nearThresholdCeiling) {
  if (!nearThresholdCeiling) return 0;
  const floor = nearThresholdCeiling * 0.9;
  const inBand = (amount) => amount >= floor && amount < nearThresholdCeiling;
  const historyCount = history.filter((row) => (
    minutesBetween(row.txnTime, txn.txnTime) <= NEAR_THRESHOLD_WINDOW_HOURS * 60 && inBand(row.amount)
  )).length;
  return historyCount + (inBand(txn.amount) ? 1 : 0);
}

// "Foreign" means outside the merchant's home country plus, once a CDD expected-activity
// profile is on file, its declared expected-countries allowlist - so a merchant that
// legitimately serves several declared markets doesn't get flagged for its normal business,
// while a country outside that declared baseline still counts as a deviation. Falls back to
// home-country-only when no expected-countries profile exists (legacy behaviour).
function isForeignCountry(issuerCountry, txn) {
  if (!issuerCountry) return false;
  const allowlist = [txn.merchantCountry, ...(txn.merchantExpectedCountries || [])];
  return !allowlist.includes(issuerCountry);
}

function buildDerivedSignals(txn, history) {
  const storeVelocity = history.filter((row) => (
    row.storeId === txn.storeId && minutesBetween(row.txnTime, txn.txnTime) <= STORE_VELOCITY_WINDOW_MIN
  )).length + 1;

  const crossStoreWindow = history.filter((row) => minutesBetween(row.txnTime, txn.txnTime) <= CROSS_STORE_VELOCITY_WINDOW_MIN);
  const distinctStores = new Set([...crossStoreWindow.map((row) => row.storeId), txn.storeId]);

  const aggregate24h = history
    .filter((row) => minutesBetween(row.txnTime, txn.txnTime) <= AGGREGATE_WINDOW_HOURS * 60)
    .reduce((sum, row) => sum + row.amount, 0) + txn.amount;

  const foreignIssuerCount = history.filter((row) => (
    isForeignCountry(row.issuerCountry, txn)
    && minutesBetween(row.txnTime, txn.txnTime) <= FOREIGN_ISSUER_WINDOW_MIN
  )).length + (isForeignCountry(txn.issuerCountry, txn) ? 1 : 0);

  const cardTestingBurst = history.filter((row) => (
    row.storeId === txn.storeId && row.amount < CARD_TESTING_AMOUNT_CEILING
    && minutesBetween(row.txnTime, txn.txnTime) <= CARD_TESTING_WINDOW_MIN
  )).length + (txn.amount < CARD_TESTING_AMOUNT_CEILING ? 1 : 0);

  // Same-card signals: matched on card_ref (a tokenised/hashed card reference from the partner
  // feed, never a raw PAN - see src/database.js ensurePartnerSchema). No cardRef on this
  // transaction means these fall back to "this transaction alone" rather than false-matching
  // every other cardless row against each other.
  const cardSpend24h = txn.cardRef
    ? history
      .filter((row) => row.cardRef === txn.cardRef && minutesBetween(row.txnTime, txn.txnTime) <= CARD_SPEND_WINDOW_HOURS * 60)
      .reduce((sum, row) => sum + row.amount, 0) + txn.amount
    : txn.amount;

  const lowValueCardBurst = txn.cardRef
    ? history.filter((row) => (
      row.cardRef === txn.cardRef && row.amount < CARD_TESTING_AMOUNT_CEILING
      && minutesBetween(row.txnTime, txn.txnTime) <= LOW_VALUE_CARD_BURST_WINDOW_MIN
    )).length + (txn.amount < CARD_TESTING_AMOUNT_CEILING ? 1 : 0)
    : (txn.amount < CARD_TESTING_AMOUNT_CEILING ? 1 : 0);

  return {
    storeVelocity,
    crossStoreVelocity: distinctStores.size,
    aggregate24h,
    foreignIssuerCount,
    cardTestingBurst,
    cardSpend24h,
    lowValueCardBurst,
  };
}

function getTransactionHour(txnTime) {
  return txnTime.getHours();
}

function isOutsideOperatingHours(hour, hours = OPERATING_HOURS) {
  return hour < hours.openHour || hour >= hours.closeHour;
}

function isForeignIssuer(txn) {
  return isForeignCountry(txn.issuerCountry, txn);
}

// rules: active compliance_rules rows for this merchant plus global (merchant_id IS NULL) rows.
function evaluateAgainstRules(txn, rules, signals, history) {
  const matched = [];

  for (const rule of rules) {
    const threshold = rule.amount_threshold === null ? null : Number(rule.amount_threshold);
    const count = rule.count_threshold === null ? null : Number(rule.count_threshold);
    let hit = false;

    switch (rule.rule_type) {
      case 'amount_spike':
        hit = threshold !== null && txn.amount > threshold;
        break;
      case 'declared_avg_ticket': {
        // A merchant's own CDD-declared expected ticket size, when on file, is a tighter and
        // more meaningful baseline than the generic static per-rule threshold it replaces -
        // "3x expected ticket" is the deviation band; falls back to the legacy static
        // threshold for merchants with no expected-activity profile yet.
        const declaredThreshold = txn.merchantExpectedAvgTicket ? txn.merchantExpectedAvgTicket * 3 : threshold;
        hit = declaredThreshold !== null && declaredThreshold !== undefined && txn.amount >= declaredThreshold;
        break;
      }
      case 'store_velocity':
        hit = count !== null && signals.storeVelocity >= count;
        break;
      case 'cross_store_velocity':
        hit = count !== null && signals.crossStoreVelocity >= count;
        break;
      case 'aggregate_24h':
        hit = threshold !== null && signals.aggregate24h > threshold;
        break;
      case 'near_threshold':
        hit = threshold !== null && count !== null && countNearThreshold(history, txn, threshold) >= count;
        break;
      case 'operating_hours':
        // Merchant's own CDD-declared operating hours take priority over the global default
        // window once on file, so "outside hours" reflects that merchant's real baseline.
        hit = txn.merchantExpectedOperatingHours
          ? isOutsideOperatingHours(getTransactionHour(txn.txnTime), txn.merchantExpectedOperatingHours)
          : isOutsideOperatingHours(getTransactionHour(txn.txnTime));
        break;
      case 'foreign_issuer':
        hit = isForeignIssuer(txn);
        break;
      case 'foreign_issuer_concentration':
        hit = count !== null && signals.foreignIssuerCount >= count;
        break;
      case 'card_testing_burst':
        hit = count !== null && signals.cardTestingBurst >= count;
        break;
      case 'card_spend_24h':
        hit = threshold !== null && signals.cardSpend24h > threshold;
        break;
      case 'low_value_burst':
        hit = count !== null && signals.lowValueCardBurst >= count;
        break;
      case 'edd_high_risk':
        // Completing the EDD checklist (see src/lib/merchantCdd.js) actually removes this
        // contribution from future transactions - the static risk_tier flag alone is no
        // longer enough once a real due-diligence record exists.
        hit = txn.merchantRiskTier === 'High' && !txn.merchantEddComplete;
        break;
      case 'cdd_review_overdue':
        hit = Boolean(txn.merchantCddReviewOverdue);
        break;
      case 'cvv_check_failed':
        hit = txn.cvvValidationResult === 'Failed';
        break;
      case 'expiry_check_failed':
        hit = txn.expiryValidationResult === 'Failed';
        break;
      default:
        hit = false;
    }

    if (hit) {
      matched.push({
        id: rule.rule_id, name: rule.rule_name, risk: rule.risk_level, reason: rule.reason, weight: Number(rule.weight) || 0,
      });
    }
  }

  return matched;
}

// txn: { merchantId, merchantMid, merchantCountry, merchantRiskTier, mccRiskScore,
//        merchantExpectedAvgTicket, merchantExpectedOperatingHours, merchantExpectedCountries,
//        merchantCddReviewOverdue, merchantEddComplete (all optional, from merchantCdd.js -
//        absent means legacy/no-CDD-data behaviour), storeId,
//        amount, issuerCountry, txnTime (Date), cardRef (optional tokenised card reference),
//        cvvValidationResult, expiryValidationResult (optional, 'Passed'/'Failed'/'Unavailable' -
//        only an explicit 'Failed' scores; 'Unavailable' is treated as no signal) }
async function evaluateTransaction({
  txn, database,
}) {
  const [history, ruleRows, profileRiskContribution] = await Promise.all([
    loadRecentMerchantHistory(database, txn.merchantId, txn.txnTime),
    complianceRuleModel.findActiveForMerchant(database, txn.merchantId),
    loadMerchantProfileContribution(database, txn.merchantMid),
  ]);

  const signals = buildDerivedSignals(txn, history);
  const matchedRules = evaluateAgainstRules(txn, ruleRows, signals, history);
  const mccRiskContribution = Number(txn.mccRiskScore) || 0;
  const detectionContribution = matchedRules.reduce((sum, rule) => sum + rule.weight, 0);
  // Real additive formula, computed once here and persisted verbatim - the view must never
  // re-derive or invent this number (see the old unpersistedRiskContribution bug it replaces).
  const riskScore = Math.min(100, mccRiskContribution + profileRiskContribution + detectionContribution);
  const riskLevel = riskLevelFromScore(riskScore);
  // A single low-weight rule match (e.g. a foreign-issued card alone) shouldn't open a case -
  // status follows the overall risk band, matching the existing convention where a Low-risk
  // transaction stays Cleared even with one minor rule hit.
  const status = riskLevel === 'Low' ? 'Cleared' : 'Flagged';

  return {
    riskScore,
    riskLevel,
    status,
    matchedRules,
    signals,
    mccRiskContribution,
    profileRiskContribution,
    detectionContribution,
  };
}

module.exports = {
  evaluateTransaction,
  riskLevelFromScore,
  isOutsideOperatingHours,
  isForeignIssuer,
  getTransactionHour,
  OPERATING_HOURS,
};
