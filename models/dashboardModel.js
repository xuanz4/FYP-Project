const database = require('../src/database');

// Cross-entity summary counts for the Admin Overview page - doesn't belong to any single table's
// model, so it lives here rather than being force-fit into one of them.
async function findAdminSummary() {
  const [rows] = await database.query(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_users,
       (SELECT COUNT(*) FROM users WHERE is_active = 0) AS disabled_users,
       (SELECT COUNT(*) FROM merchants WHERE is_active = 1) AS active_merchants,
       (SELECT COUNT(*) FROM compliance_rules WHERE is_active = 1) AS active_rules,
       (SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = CURDATE()) AS transactions_today,
       (SELECT COUNT(*) FROM cases WHERE status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases`,
  );
  return rows[0] || {};
}

module.exports = { findAdminSummary };
