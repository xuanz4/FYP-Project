// Seeds the industry partner's 1000-row transaction export as real historical data, plus
// per-merchant compliance-rule thresholds computed from that data. Used both by the
// `npm run import:test-data` CLI and by app.js's auto-seed on server startup. Safe to call
// on every startup: no-ops once the first transaction row already exists.
const { ensureMerchant, ingestTransaction } = require('../transactionIngestion');

const transactions = require('../../scripts/data/partnerTransactions.json');
const merchants = require('../../scripts/data/merchants.json');

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values, avg) {
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Per-merchant thresholds derived from that merchant's own real transaction history, in the
// same spirit as the original hand-picked MERCH-A/B/C thresholds in FYP_Transaction_Monitoring.sql,
// but computed rather than guessed. Admin can still hand-edit any of these afterwards via /admin/rules.
function buildMerchantRuleRows(merchantId, amounts) {
  const avg = mean(amounts);
  const sd = stddev(amounts, avg);
  const mediumThreshold = Math.round((avg + 2 * sd) * 100) / 100;
  const highThreshold = Math.round((avg + 4 * sd) * 100) / 100;
  const declaredAvgTicketThreshold = Math.round(avg * 10 * 100) / 100;
  const aggregate24hThreshold = Math.round(avg * 20 * 100) / 100;

  return [
    {
      ruleId: `${merchantId}-AMT-01`, merchantId, ruleName: 'Amount spike vs merchant average (medium)', riskLevel: 'Medium',
      reason: `Amount is more than 2 standard deviations above this merchant's average ticket (avg S$${avg.toFixed(2)})`,
      weight: 20, amountThreshold: mediumThreshold, countThreshold: null, ruleType: 'amount_spike',
    },
    {
      ruleId: `${merchantId}-AMT-02`, merchantId, ruleName: 'Amount spike vs merchant average (high)', riskLevel: 'High',
      reason: `Amount is more than 4 standard deviations above this merchant's average ticket (avg S$${avg.toFixed(2)})`,
      weight: 35, amountThreshold: highThreshold, countThreshold: null, ruleType: 'amount_spike',
    },
    {
      ruleId: `${merchantId}-PR-AOV-01`, merchantId, ruleName: '10x declared average ticket', riskLevel: 'Critical',
      reason: `Amount is at least 10x this merchant's average ticket (avg S$${avg.toFixed(2)})`,
      weight: 40, amountThreshold: declaredAvgTicketThreshold, countThreshold: null, ruleType: 'declared_avg_ticket',
    },
    {
      ruleId: `${merchantId}-FREQ-02`, merchantId, ruleName: '4+ transactions at the same store within 30 min', riskLevel: 'Medium',
      reason: 'Possible split payment or repeated card attempts at a single store', weight: 15, amountThreshold: null, countThreshold: 4, ruleType: 'store_velocity',
    },
    {
      ruleId: `${merchantId}-TR-005`, merchantId, ruleName: '24h aggregate spend build-up', riskLevel: 'High',
      reason: `Cumulative merchant spend within 24h far exceeds typical daily volume (avg ticket S$${avg.toFixed(2)})`,
      weight: 25, amountThreshold: aggregate24hThreshold, countThreshold: null, ruleType: 'aggregate_24h',
    },
    {
      ruleId: `${merchantId}-STR-01`, merchantId, ruleName: 'Structuring band just under medium threshold', riskLevel: 'Medium',
      reason: `3+ transactions within 24h sitting just under the S$${mediumThreshold.toFixed(2)} medium-amount threshold`,
      weight: 15, amountThreshold: mediumThreshold, countThreshold: 3, ruleType: 'near_threshold',
    },
  ];
}

// Generic AML concepts that apply the same way regardless of merchant (merchant_id NULL).
// Off-hours is intentionally not redefined here - FYP_Transaction_Monitoring.sql already
// seeds a global TIME-001 rule (rule_type 'operating_hours') and the risk engine matches by
// rule_type, not rule_id, so adding a second row would double-count the same signal.
const globalRuleRows = [
  {
    ruleId: 'XB-01', merchantId: null, ruleName: 'Foreign-issued card', riskLevel: 'Low',
    reason: "Card issuer country differs from the merchant's home country", weight: 10, amountThreshold: null, countThreshold: null, ruleType: 'foreign_issuer',
  },
  {
    ruleId: 'TL-01', merchantId: null, ruleName: 'Foreign-issuer concentration', riskLevel: 'High',
    reason: '3+ foreign-issued card transactions at this merchant within 1 hour', weight: 20, amountThreshold: null, countThreshold: 3, ruleType: 'foreign_issuer_concentration',
  },
  {
    ruleId: 'CT-01', merchantId: null, ruleName: 'Low-value card testing burst', riskLevel: 'High',
    reason: '5+ sub-S$20 transactions at the same store within 10 minutes may indicate card testing', weight: 30, amountThreshold: null, countThreshold: 5, ruleType: 'card_testing_burst',
  },
  {
    ruleId: 'FREQ-03', merchantId: null, ruleName: 'Cross-store velocity', riskLevel: 'Medium',
    reason: '2+ distinct stores at the same merchant used within 30 minutes', weight: 20, amountThreshold: null, countThreshold: 2, ruleType: 'cross_store_velocity',
  },
  {
    ruleId: 'DD-01', merchantId: null, ruleName: 'High-risk merchant (EDD required)', riskLevel: 'Medium',
    reason: 'Merchant is in a cash-intensive/high-AML-risk industry requiring enhanced due diligence', weight: 20, amountThreshold: null, countThreshold: null, ruleType: 'edd_high_risk',
  },
];

async function upsertRule(database, rule) {
  await database.execute(
    `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       rule_name = VALUES(rule_name), risk_level = VALUES(risk_level), reason = VALUES(reason),
       weight = VALUES(weight), amount_threshold = VALUES(amount_threshold), count_threshold = VALUES(count_threshold)`,
    [rule.ruleId, rule.merchantId, rule.ruleName, rule.riskLevel, rule.reason, rule.weight, rule.amountThreshold, rule.countThreshold, rule.ruleType],
  );
}

async function seedTestData(database) {
  const [[{ existing }]] = await database.query('SELECT COUNT(*) AS existing FROM transactions WHERE transaction_id = ?', [transactions[0].id]);
  if (existing > 0) {
    return { seeded: false };
  }

  for (const merchant of merchants) {
    await ensureMerchant(database, merchant);
  }

  const amountsByMerchant = {};
  for (const txn of transactions) {
    (amountsByMerchant[txn.merchantId] ||= []).push(txn.amount);
  }
  for (const merchant of merchants) {
    const rows = buildMerchantRuleRows(merchant.merchantId, amountsByMerchant[merchant.merchantId] || [0]);
    for (const rule of rows) await upsertRule(database, rule);
  }
  for (const rule of globalRuleRows) await upsertRule(database, rule);

  const merchantById = Object.fromEntries(merchants.map((m) => [m.merchantId, m]));
  let flagged = 0;
  for (const raw of transactions) {
    const evaluation = await ingestTransaction(database, raw, merchantById[raw.merchantId]);
    if (evaluation.status === 'Flagged') flagged += 1;
  }

  return { seeded: true, imported: transactions.length, flagged };
}

module.exports = { seedTestData };
