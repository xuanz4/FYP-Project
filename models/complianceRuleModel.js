const database = require('../src/database');

// riskEngine.js always passes its own db explicitly (the real database, or a test's fake).
async function findActiveForMerchant(db, merchantId) {
  const [rows] = await db.query(
    `SELECT rule_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type
     FROM compliance_rules
     WHERE is_active = 1 AND (merchant_id = ? OR merchant_id IS NULL)`,
    [merchantId],
  );
  return rows;
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(`SELECT COUNT(*) AS total FROM compliance_rules cr ${whereSql}`, values);
  return Number(rows[0]?.total || 0);
}

async function listFiltered(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT cr.rule_id, cr.merchant_id, cr.rule_name, cr.risk_level, cr.reason, cr.weight,
            cr.amount_threshold, cr.count_threshold, cr.rule_type, cr.is_active,
            m.merchant_name
     FROM compliance_rules cr
     LEFT JOIN merchants m ON m.merchant_id = cr.merchant_id
     ${whereSql}
     ORDER BY cr.rule_name ASC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function listDistinctRuleTypes() {
  const [rows] = await database.query('SELECT DISTINCT rule_type FROM compliance_rules ORDER BY rule_type ASC');
  return rows;
}

async function upsert({
  ruleId, merchantId, ruleName, riskLevel, reason, weight, amountThreshold, countThreshold, ruleType, isActive,
}) {
  const [result] = await database.execute(
    `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       merchant_id = VALUES(merchant_id),
       rule_name = VALUES(rule_name),
       risk_level = VALUES(risk_level),
       reason = VALUES(reason),
       weight = VALUES(weight),
       amount_threshold = VALUES(amount_threshold),
       count_threshold = VALUES(count_threshold),
       rule_type = VALUES(rule_type),
       is_active = VALUES(is_active)`,
    [ruleId, merchantId, ruleName, riskLevel, reason, weight, amountThreshold, countThreshold, ruleType, isActive ? 1 : 0],
  );
  return result;
}

async function updateFields(ruleId, setSql, values) {
  await database.execute(`UPDATE compliance_rules SET ${setSql} WHERE rule_id = ?`, [...values, ruleId]);
}

async function deleteById(ruleId) {
  await database.execute('DELETE FROM compliance_rules WHERE rule_id = ?', [ruleId]);
}

module.exports = {
  findActiveForMerchant, countFiltered, listFiltered, listDistinctRuleTypes, upsert, updateFields, deleteById,
};
