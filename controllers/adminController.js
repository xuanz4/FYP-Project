const database = require('../src/database');
const emailService = require('../src/services/emailService');
const { paginationMeta, appendWhere } = require('../src/lib/query');
const { logAdminAudit } = require('../src/lib/auditLog');
const { ensureMerchantContactsTable } = require('../src/lib/schema');
const { id } = require('../src/lib/ids');

function adminFiltersFromQuery(query) {
  return {
    role: String(query.role || '').trim(),
    status: String(query.status || '').trim(),
    industry: String(query.industry || '').trim(),
    mcc: String(query.mcc || '').trim(),
    riskLevel: String(query.riskLevel || '').trim(),
    ruleType: String(query.ruleType || '').trim(),
    merchantId: String(query.merchantId || '').trim(),
    actionType: String(query.actionType || '').trim(),
    userId: String(query.userId || '').trim(),
    userRole: String(query.userRole || '').trim(),
    entityType: String(query.entityType || '').trim(),
    dateFrom: String(query.dateFrom || '').trim(),
    dateTo: String(query.dateTo || '').trim(),
    q: String(query.q || '').trim(),
  };
}

async function loadAdminUsers(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'user_role = ?', filters.role);
  if (filters.status === 'active') where.push('is_active = 1');
  if (filters.status === 'inactive') where.push('is_active = 0');
  if (filters.q) { where.push('(user_id LIKE ? OR user_name LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT user_id, user_name, user_role, is_active FROM users ${whereSql} ORDER BY user_name ASC LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  return { rows, filters, pagination };
}

async function loadAdminMerchants(req) {
  await ensureMerchantContactsTable();
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  if (filters.status === 'active') where.push('m.is_active = 1');
  if (filters.status === 'inactive') where.push('m.is_active = 0');
  appendWhere(where, values, 'm.industry = ?', filters.industry);
  appendWhere(where, values, 'm.mcc_code = ?', filters.mcc);
  if (filters.q) { where.push('(m.merchant_id LIKE ? OR m.merchant_name LIKE ? OR m.industry LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM merchants m ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT m.merchant_id, m.merchant_name, m.merchant_mid, m.merchant_country,
            m.mcc_code, m.industry, m.mcc_risk_score, m.risk_tier, m.is_active,
            mc.contact_name, mc.rfi_email, mc.phone_number, mc.store_id AS contact_store_id, mc.status AS contact_status
     FROM merchants m
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = m.merchant_id
     ${whereSql} ORDER BY m.merchant_name ASC LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [industries] = await database.query('SELECT DISTINCT industry FROM merchants ORDER BY industry ASC');
  const [mccs] = await database.query('SELECT DISTINCT mcc_code FROM merchants ORDER BY mcc_code ASC');
  return { rows, industries, mccs, filters, pagination };
}

// Upserts the single merchant_contacts row for this merchant and writes one audit_logs entry
// per changed field, so contact edits are auditable (old value -> new value -> who) instead of
// silently overwriting the old single mutable merchants column.
async function upsertMerchantContactFields(req, merchantId) {
  const hasContactField = ['contactName', 'rfiEmail', 'phoneNumber', 'contactStoreId'].some((field) => req.body[field] !== undefined);
  if (!hasContactField) return;

  await ensureMerchantContactsTable();
  const contactName = String(req.body.contactName || '').trim() || null;
  const rfiEmail = String(req.body.rfiEmail || '').trim() || null;
  const phoneNumber = String(req.body.phoneNumber || '').trim() || null;
  const storeId = String(req.body.contactStoreId || '').trim() || null;
  if (rfiEmail && !emailService.isValidEmail(rfiEmail)) return;

  const [existingRows] = await database.query(
    'SELECT contact_name, rfi_email, phone_number, store_id FROM merchant_contacts WHERE merchant_id = ? LIMIT 1',
    [merchantId],
  );
  const existing = existingRows[0] || {};

  const [merchantRows] = await database.query('SELECT merchant_mid FROM merchants WHERE merchant_id = ? LIMIT 1', [merchantId]);
  const merchantMid = merchantRows[0]?.merchant_mid || null;

  await database.execute(
    `INSERT INTO merchant_contacts (contact_id, merchant_id, merchant_mid, store_id, contact_name, rfi_email, phone_number, status, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, NOW())
     ON DUPLICATE KEY UPDATE
       merchant_mid = VALUES(merchant_mid),
       store_id = VALUES(store_id),
       contact_name = VALUES(contact_name),
       rfi_email = VALUES(rfi_email),
       phone_number = VALUES(phone_number),
       updated_by = VALUES(updated_by),
       updated_at = NOW()`,
    [id('MCT'), merchantId, merchantMid, storeId, contactName, rfiEmail, phoneNumber, req.session.user.id],
  );

  const changedFields = [
    ['Contact Name', existing.contact_name, contactName],
    ['RFI Email', existing.rfi_email, rfiEmail],
    ['Phone Number', existing.phone_number, phoneNumber],
    ['Store ID', existing.store_id, storeId],
  ].filter(([, before, after]) => (before || null) !== (after || null));

  for (const [fieldLabel, before, after] of changedFields) {
    await logAdminAudit({
      action: 'Merchant Contact Updated',
      userId: req.session.user.id,
      entityType: 'MerchantContact',
      entityId: merchantId,
      notes: `${fieldLabel} changed from "${before || 'empty'}" to "${after || 'empty'}"`,
    });
  }
}

async function loadAdminRules(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'cr.merchant_id = ?', filters.merchantId);
  appendWhere(where, values, 'cr.risk_level = ?', filters.riskLevel);
  appendWhere(where, values, 'cr.rule_type = ?', filters.ruleType);
  if (filters.status === 'active') where.push('cr.is_active = 1');
  if (filters.status === 'inactive') where.push('cr.is_active = 0');
  if (filters.q) { where.push('(cr.rule_id LIKE ? OR cr.rule_name LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM compliance_rules cr ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 15);
  const [rows] = await database.query(
    `SELECT cr.rule_id, cr.merchant_id, cr.rule_name, cr.risk_level, cr.reason, cr.weight,
            cr.amount_threshold, cr.count_threshold, cr.rule_type, cr.is_active,
            m.merchant_name
     FROM compliance_rules cr
     LEFT JOIN merchants m ON m.merchant_id = cr.merchant_id
     ${whereSql}
     ORDER BY cr.rule_name ASC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [merchants] = await database.query('SELECT merchant_id, merchant_name FROM merchants WHERE is_active = 1 ORDER BY merchant_name ASC');
  const [ruleTypes] = await database.query('SELECT DISTINCT rule_type FROM compliance_rules ORDER BY rule_type ASC');
  return { rows, merchants, ruleTypes, filters, pagination };
}

async function loadAdminAudit(req) {
  const filters = adminFiltersFromQuery(req.query);
  const where = [];
  const values = [];
  appendWhere(where, values, 'al.action = ?', filters.actionType);
  appendWhere(where, values, 'al.user_id = ?', filters.userId);
  appendWhere(where, values, 'u.user_role = ?', filters.userRole);
  appendWhere(where, values, 'al.entity_type = ?', filters.entityType);
  if (filters.dateFrom) { where.push('DATE(al.created_at) >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('DATE(al.created_at) <= ?'); values.push(filters.dateTo); }
  if (filters.q) { where.push('(al.transaction_id LIKE ? OR al.entity_id LIKE ? OR al.action LIKE ? OR al.notes LIKE ?)'); values.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await database.query(`SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${whereSql}`, values);
  const pagination = paginationMeta(req, Number(countRows[0]?.total || 0), 20);
  const [rows] = await database.query(
    `SELECT al.audit_id, al.transaction_id, al.entity_type, al.entity_id, al.action,
            al.user_id, al.notes, al.created_at, u.user_name, u.user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.user_id
     ${whereSql}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, pagination.limit, pagination.offset],
  );
  const [actions] = await database.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
  const [users] = await database.query('SELECT user_id, user_name, user_role FROM users ORDER BY user_name ASC');
  const [entities] = await database.query('SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type ASC');
  return { rows, actions, users, entities, filters, pagination };
}

async function dashboard(req, res) {
  const previewReq = Object.create(req);
  previewReq.session = req.session;
  previewReq.query = { limit: 5 };
  const [usersData, merchantsData, rulesData, auditData, summaryRows] = await Promise.all([
    loadAdminUsers(previewReq),
    loadAdminMerchants(previewReq),
    loadAdminRules(previewReq),
    loadAdminAudit(previewReq),
    database.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_users,
         (SELECT COUNT(*) FROM users WHERE is_active = 0) AS disabled_users,
         (SELECT COUNT(*) FROM merchants WHERE is_active = 1) AS active_merchants,
         (SELECT COUNT(*) FROM compliance_rules WHERE is_active = 1) AS active_rules,
         (SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = CURDATE()) AS transactions_today,
         (SELECT COUNT(*) FROM cases WHERE status NOT IN ('Resolved', 'Dismissed as False Positive', 'STR Filed')) AS open_cases`,
    ).then(([rows]) => rows),
  ]);
  const userRoleDistribution = ['Analyst', 'Senior Analyst', 'STRO', 'Admin'].map((role) => ({
    role,
    count: auditData.users.filter((user) => user.user_role === role).length,
  }));
  return res.render('admin-dashboard', {
    title: 'Admin Overview',
    activePage: 'admin',
    currentUser: req.session.user,
    summary: summaryRows[0] || {},
    userPreview: usersData.rows.slice(0, 5),
    merchantPreview: merchantsData.rows.slice(0, 5),
    rulePreview: rulesData.rows.slice(0, 5),
    auditPreview: auditData.rows.slice(0, 5),
    auditTotal: auditData.pagination.total,
    userRoleDistribution,
  });
}

async function usersPage(req, res) {
  const data = await loadAdminUsers(req);
  return res.render('admin-users', {
    title: 'User Management',
    activePage: 'admin-users',
    currentUser: req.session.user,
    ...data,
  });
}

async function merchantsPage(req, res) {
  const data = await loadAdminMerchants(req);
  return res.render('admin-merchants', {
    title: 'Merchant Management',
    activePage: 'admin-merchants',
    currentUser: req.session.user,
    ...data,
  });
}

async function rulesPage(req, res) {
  const data = await loadAdminRules(req);
  return res.render('admin-rules', {
    title: 'Rule Management',
    activePage: 'admin-rules',
    currentUser: req.session.user,
    ...data,
  });
}

async function auditLogPage(req, res) {
  const data = await loadAdminAudit(req);
  return res.render('admin-audit-log', {
    title: 'Admin Audit Log',
    activePage: 'admin-audit-log',
    currentUser: req.session.user,
    query: req.query,
    ...data,
  });
}

async function createUser(req, res) {
  const userId = String(req.body.userId || '').trim();
  const userName = String(req.body.userName || '').trim();
  const userRole = String(req.body.userRole || '').trim();
  const password = String(req.body.password || '');
  const isActive = req.body.isActive !== '0';
  if (!userId || !userName || !userRole || !password) return res.redirect('/admin/users');

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

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'User Created' : 'User Updated',
    userId: req.session.user.id,
    entityType: 'User',
    entityId: userId,
    notes: `${userName} (${userRole})`,
  });

  return res.redirect('/admin/users');
}

async function updateUser(req, res) {
  const isSelf = req.params.id === req.session.user.id;
  const updates = [];
  const values = [];
  if (req.body.userName) { updates.push('user_name = ?'); values.push(String(req.body.userName).trim()); }
  if (req.body.userRole && !isSelf) { updates.push('user_role = ?'); values.push(String(req.body.userRole).trim()); }
  if (req.body.password) { updates.push('password = SHA2(?, 256)'); values.push(String(req.body.password)); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, values);
    await logAdminAudit({
      action: 'User Updated',
      userId: req.session.user.id,
      entityType: 'User',
      entityId: req.params.id,
      notes: req.body.userRole && isSelf ? 'Role change ignored: admin cannot change their own role' : null,
    });
  }
  return res.redirect('/admin/users');
}

async function toggleUser(req, res) {
  const [rows] = await database.query('SELECT is_active FROM users WHERE user_id = ? LIMIT 1', [req.params.id]);
  const current = rows[0];
  if (current) {
    const nextActive = current.is_active ? 0 : 1;
    await database.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [nextActive, req.params.id]);
    await logAdminAudit({
      action: nextActive ? 'User Activated' : 'User Deactivated',
      userId: req.session.user.id,
      entityType: 'User',
      entityId: req.params.id,
    });
  }
  return res.redirect('/admin/users');
}

async function deleteUser(req, res) {
  await database.execute('DELETE FROM users WHERE user_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'User Deleted',
    userId: req.session.user.id,
    entityType: 'User',
    entityId: req.params.id,
  });
  return res.redirect('/admin/users');
}

async function createMerchant(req, res) {
  const merchantId = String(req.body.merchantId || '').trim();
  const merchantName = String(req.body.merchantName || '').trim();
  const mccCode = String(req.body.mccCode || '').trim();
  const industry = String(req.body.industry || '').trim();
  const mccRiskScore = Number(req.body.mccRiskScore || 0);
  const merchantMid = String(req.body.merchantMid || '').trim() || null;
  const merchantCountry = String(req.body.merchantCountry || '').trim() || null;
  const riskTier = req.body.riskTier === 'High' ? 'High' : 'Standard';
  const isActive = req.body.isActive !== '0';
  if (!merchantId || !merchantName || !mccCode || !industry) return res.redirect('/admin/merchants');

  const [result] = await database.execute(
    `INSERT INTO merchants (merchant_id, merchant_name, mcc_code, industry, mcc_risk_score, merchant_mid, merchant_country, risk_tier, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       merchant_name = VALUES(merchant_name),
       mcc_code = VALUES(mcc_code),
       industry = VALUES(industry),
       mcc_risk_score = VALUES(mcc_risk_score),
       merchant_mid = VALUES(merchant_mid),
       merchant_country = VALUES(merchant_country),
       risk_tier = VALUES(risk_tier),
       is_active = VALUES(is_active)`,
    [merchantId, merchantName, mccCode, industry, mccRiskScore, merchantMid, merchantCountry, riskTier, isActive ? 1 : 0],
  );

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'Merchant Created' : 'Merchant Updated',
    userId: req.session.user.id,
    entityType: 'Merchant',
    entityId: merchantId,
    notes: `${merchantName} (MCC ${mccCode})`,
  });
  await upsertMerchantContactFields(req, merchantId);

  return res.redirect('/admin/merchants');
}

async function updateMerchant(req, res) {
  const updates = [];
  const values = [];
  if (req.body.merchantName) { updates.push('merchant_name = ?'); values.push(String(req.body.merchantName).trim()); }
  if (req.body.mccCode) { updates.push('mcc_code = ?'); values.push(String(req.body.mccCode).trim()); }
  if (req.body.industry) { updates.push('industry = ?'); values.push(String(req.body.industry).trim()); }
  if (req.body.mccRiskScore !== undefined) { updates.push('mcc_risk_score = ?'); values.push(Number(req.body.mccRiskScore || 0)); }
  if (req.body.merchantMid !== undefined) { updates.push('merchant_mid = ?'); values.push(String(req.body.merchantMid).trim() || null); }
  if (req.body.merchantCountry !== undefined) { updates.push('merchant_country = ?'); values.push(String(req.body.merchantCountry).trim() || null); }
  if (req.body.riskTier !== undefined) { updates.push('risk_tier = ?'); values.push(req.body.riskTier === 'High' ? 'High' : 'Standard'); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE merchants SET ${updates.join(', ')} WHERE merchant_id = ?`, values);
    await logAdminAudit({
      action: 'Merchant Updated',
      userId: req.session.user.id,
      entityType: 'Merchant',
      entityId: req.params.id,
    });
  }
  await upsertMerchantContactFields(req, req.params.id);
  return res.redirect('/admin/merchants');
}

async function deleteMerchant(req, res) {
  await database.execute('DELETE FROM merchants WHERE merchant_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'Merchant Deleted',
    userId: req.session.user.id,
    entityType: 'Merchant',
    entityId: req.params.id,
  });
  return res.redirect('/admin/merchants');
}

async function createRule(req, res) {
  const payload = {
    ruleId: String(req.body.ruleId || '').trim(),
    merchantId: req.body.merchantId ? String(req.body.merchantId).trim() : null,
    ruleName: String(req.body.ruleName || '').trim(),
    riskLevel: String(req.body.riskLevel || 'Low').trim(),
    reason: String(req.body.reason || '').trim(),
    weight: Number(req.body.weight || 0),
    amountThreshold: req.body.amountThreshold ? Number(req.body.amountThreshold) : null,
    countThreshold: req.body.countThreshold ? Number(req.body.countThreshold) : null,
    ruleType: String(req.body.ruleType || 'runtime_rule').trim(),
    isActive: req.body.isActive !== '0',
  };

  if (!payload.ruleId || !payload.ruleName || !payload.reason) return res.redirect('/admin/rules');

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
    [payload.ruleId, payload.merchantId, payload.ruleName, payload.riskLevel, payload.reason, payload.weight, payload.amountThreshold, payload.countThreshold, payload.ruleType, payload.isActive ? 1 : 0],
  );

  await logAdminAudit({
    action: result.insertId || result.affectedRows === 1 ? 'Rule Created' : 'Rule Updated',
    userId: req.session.user.id,
    entityType: 'Rule',
    entityId: payload.ruleId,
    notes: payload.ruleName,
  });

  return res.redirect('/admin/rules');
}

async function updateRule(req, res) {
  const updates = [];
  const values = [];
  if (req.body.merchantId !== undefined) { updates.push('merchant_id = ?'); values.push(req.body.merchantId ? String(req.body.merchantId).trim() : null); }
  if (req.body.ruleName) { updates.push('rule_name = ?'); values.push(String(req.body.ruleName).trim()); }
  if (req.body.riskLevel) { updates.push('risk_level = ?'); values.push(String(req.body.riskLevel).trim()); }
  if (req.body.reason) { updates.push('reason = ?'); values.push(String(req.body.reason).trim()); }
  if (req.body.weight !== undefined) { updates.push('weight = ?'); values.push(Number(req.body.weight || 0)); }
  if (req.body.amountThreshold !== undefined) { updates.push('amount_threshold = ?'); values.push(req.body.amountThreshold === '' ? null : Number(req.body.amountThreshold)); }
  if (req.body.countThreshold !== undefined) { updates.push('count_threshold = ?'); values.push(req.body.countThreshold === '' ? null : Number(req.body.countThreshold)); }
  if (req.body.ruleType) { updates.push('rule_type = ?'); values.push(String(req.body.ruleType).trim()); }
  if (typeof req.body.isActive !== 'undefined') { updates.push('is_active = ?'); values.push(req.body.isActive === '1' || req.body.isActive === 'true' ? 1 : 0); }
  if (updates.length) {
    values.push(req.params.id);
    await database.execute(`UPDATE compliance_rules SET ${updates.join(', ')} WHERE rule_id = ?`, values);
    await logAdminAudit({
      action: 'Rule Updated',
      userId: req.session.user.id,
      entityType: 'Rule',
      entityId: req.params.id,
    });
  }
  return res.redirect('/admin/rules');
}

async function deleteRule(req, res) {
  await database.execute('DELETE FROM compliance_rules WHERE rule_id = ?', [req.params.id]);
  await logAdminAudit({
    action: 'Rule Deleted',
    userId: req.session.user.id,
    entityType: 'Rule',
    entityId: req.params.id,
  });
  return res.redirect('/admin/rules');
}

module.exports = {
  dashboard,
  usersPage,
  merchantsPage,
  rulesPage,
  auditLogPage,
  createUser,
  updateUser,
  toggleUser,
  deleteUser,
  createMerchant,
  updateMerchant,
  deleteMerchant,
  createRule,
  updateRule,
  deleteRule,
};
