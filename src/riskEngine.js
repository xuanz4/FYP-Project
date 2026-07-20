// Risk engine for the partner-shaped merchant/card transaction feed (see
// FYP_Transaction_Monitoring.sql `transactions`/`compliance_rules`/`merchants`).
// Unlike the old in-memory engine, every signal here is computed from the merchant's actual
// recent transaction history in MySQL (via database.query), not randomised placeholders.
// Score is on the same 0-100 scale the rest of the app already uses (see
// app.js getRiskLevelFromScore/parseFinalRiskScore).

const OPERATING_HOURS = { openHour: 7, closeHour: 23 };
const STORE_VELOCITY_WINDOW_MIN = 30;
const CROSS_STORE_VELOCITY_WINDOW_MIN = 30;
const AGGREGATE_WINDOW_HOURS = 24;
const NEAR_THRESHOLD_WINDOW_HOURS = 24;
const FOREIGN_ISSUER_WINDOW_MIN = 60;
const CARD_TESTING_WINDOW_MIN = 10;
const CARD_TESTING_AMOUNT_CEILING = 20;

function riskLevelFromScore(score) {
  if (score >= 70) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function minutesBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

// One query per incoming transaction: everything else the rules need is derived from this
// merchant-scoped 24h window in memory, so live ingestion and historical replay both stay fast.
async function loadRecentMerchantHistory(database, merchantId, txnTime) {
  const windowStart = new Date(txnTime.getTime() - AGGREGATE_WINDOW_HOURS * 60 * 60 * 1000);
  const [rows] = await database.query(
    `SELECT store_id, amount, issuer_country, txn_time
     FROM transactions
     WHERE merchant_id = ? AND txn_time >= ? AND txn_time < ?`,
    [merchantId, windowStart, txnTime],
  );
  return rows.map((row) => ({
    storeId: row.store_id,
    amount: Number(row.amount),
    issuerCountry: row.issuer_country,
    txnTime: new Date(row.txn_time),
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
    row.issuerCountry && row.issuerCountry !== txn.merchantCountry
    && minutesBetween(row.txnTime, txn.txnTime) <= FOREIGN_ISSUER_WINDOW_MIN
  )).length + (txn.issuerCountry && txn.issuerCountry !== txn.merchantCountry ? 1 : 0);

  const cardTestingBurst = history.filter((row) => (
    row.storeId === txn.storeId && row.amount < CARD_TESTING_AMOUNT_CEILING
    && minutesBetween(row.txnTime, txn.txnTime) <= CARD_TESTING_WINDOW_MIN
  )).length + (txn.amount < CARD_TESTING_AMOUNT_CEILING ? 1 : 0);

  return {
    storeVelocity, crossStoreVelocity: distinctStores.size, aggregate24h, foreignIssuerCount, cardTestingBurst,
  };
}

function getTransactionHour(txnTime) {
  return txnTime.getHours();
}

function isOutsideOperatingHours(hour) {
  return hour < OPERATING_HOURS.openHour || hour >= OPERATING_HOURS.closeHour;
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
      case 'declared_avg_ticket':
        hit = threshold !== null && txn.amount >= threshold;
        break;
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
        hit = isOutsideOperatingHours(getTransactionHour(txn.txnTime));
        break;
      case 'foreign_issuer':
        hit = Boolean(txn.issuerCountry) && txn.issuerCountry !== txn.merchantCountry;
        break;
      case 'foreign_issuer_concentration':
        hit = count !== null && signals.foreignIssuerCount >= count;
        break;
      case 'card_testing_burst':
        hit = count !== null && signals.cardTestingBurst >= count;
        break;
      case 'edd_high_risk':
        hit = txn.merchantRiskTier === 'High';
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

// txn: { merchantId, merchantCountry, merchantRiskTier, storeId, amount, issuerCountry, txnTime (Date) }
async function evaluateTransaction({
  txn, database,
}) {
  const [history, [ruleRows]] = await Promise.all([
    loadRecentMerchantHistory(database, txn.merchantId, txn.txnTime),
    database.query(
      `SELECT rule_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type
       FROM compliance_rules
       WHERE is_active = 1 AND (merchant_id = ? OR merchant_id IS NULL)`,
      [txn.merchantId],
    ),
  ]);

  const signals = buildDerivedSignals(txn, history);
  const matchedRules = evaluateAgainstRules(txn, ruleRows, signals, history);
  const riskScore = Math.min(100, matchedRules.reduce((sum, rule) => sum + rule.weight, 0));
  const riskLevel = riskLevelFromScore(riskScore);
  // A single low-weight rule match (e.g. a foreign-issued card alone) shouldn't open a case -
  // status follows the overall risk band, matching the existing convention where a Low-risk
  // transaction stays Cleared even with one minor rule hit.
  const status = riskLevel === 'Low' ? 'Cleared' : 'Flagged';

  return {
    riskScore, riskLevel, status, matchedRules, signals,
  };
}

module.exports = {
  evaluateTransaction,
  riskLevelFromScore,
  isOutsideOperatingHours,
  getTransactionHour,
  OPERATING_HOURS,
};
