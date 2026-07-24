const database = require('../src/database');

async function listActiveAnalystsByOpenCaseCount() {
  const [rows] = await database.query(
    `SELECT u.user_id, u.user_name,
            (SELECT COUNT(*) FROM cases c2
             WHERE c2.assigned_to = u.user_id
               AND c2.status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases
     FROM users u
     WHERE u.user_role = 'Analyst' AND u.is_active = 1
     ORDER BY open_cases ASC, u.user_name ASC`,
  );
  return rows;
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, values);
  return Number(rows[0]?.total || 0);
}

async function listFiltered(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT user_id, user_name, user_role, is_active FROM users ${whereSql} ORDER BY user_name ASC LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function listAllForDropdown() {
  const [rows] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  return rows;
}

async function upsert({
  userId, userName, userRole, password, isActive,
}) {
  const [result] = await database.execute(
    `INSERT INTO users (user_id, user_name, user_role, password, is_active)
     VALUES (?, ?, ?, SHA2(?, 256), ?)
     ON DUPLICATE KEY UPDATE
       user_name = VALUES(user_name),
       user_role = VALUES(user_role),
       password = VALUES(password),
       is_active = VALUES(is_active)`,
    [userId, userName, userRole, password, isActive ? 1 : 0],
  );
  return result;
}

async function updateFields(userId, setSql, values) {
  await database.execute(`UPDATE users SET ${setSql} WHERE user_id = ?`, [...values, userId]);
}

async function findActiveFlag(userId) {
  const [rows] = await database.query('SELECT is_active FROM users WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function setActive(userId, isActive) {
  await database.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [isActive, userId]);
}

async function deleteById(userId) {
  await database.execute('DELETE FROM users WHERE user_id = ?', [userId]);
}

async function listAnalystRoleUsersForDropdown() {
  const [rows] = await database.query(
    "SELECT user_id, user_name FROM users WHERE user_role IN ('Analyst', 'Senior Analyst', 'STRO') ORDER BY user_name ASC",
  );
  return rows;
}

async function findActiveByCredentials(userId, password) {
  const [rows] = await database.query(
    `SELECT user_id, user_name, user_role, is_active
     FROM users
     WHERE user_id = ?
       AND password = SHA2(?, 256)
       AND is_active = 1
     LIMIT 1`,
    [userId, password],
  );
  return rows[0] || null;
}

module.exports = {
  listActiveAnalystsByOpenCaseCount,
  countFiltered,
  listFiltered,
  listAllForDropdown,
  upsert,
  updateFields,
  findActiveFlag,
  setActive,
  deleteById,
  findActiveByCredentials,
  listAnalystRoleUsersForDropdown,
};
