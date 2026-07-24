const database = require('../src/database');

async function findRiskSnapshotById(merchantId) {
  const [rows] = await database.query(
    'SELECT merchant_mid, merchant_country, risk_tier, mcc_risk_score FROM merchants WHERE merchant_id = ?',
    [merchantId],
  );
  return rows[0] || null;
}

async function findMidById(merchantId) {
  const [rows] = await database.query('SELECT merchant_mid FROM merchants WHERE merchant_id = ? LIMIT 1', [merchantId]);
  return rows[0]?.merchant_mid || null;
}

// Accepts an optional db client so callers that inject their own (transactionIngestion.js's
// real database param, or a test's fake) get identical query text through the same seam.
async function findRiskTierById(merchantId, db = database) {
  const [rows] = await db.query('SELECT risk_tier FROM merchants WHERE merchant_id = ? LIMIT 1', [merchantId]);
  return rows[0] || null;
}

// Distinct from upsert() above: this is the partner-feed ingestion path (transactionIngestion.js's
// ensureMerchant), which always marks the merchant active and only ever fills in contact fields
// when they're missing (COALESCE), never overwrites an existing contact with a blank one.
async function upsertFromPartnerFeed(db, {
  merchantId, merchantName, merchantMid, merchantCountry, authorisedContactName, authorisedContactEmail,
  mccCode, industry, mccRiskScore, riskTier,
}) {
  await db.execute(
    `INSERT INTO merchants (merchant_id, merchant_name, merchant_mid, merchant_country, authorised_contact_name, authorised_contact_email, mcc_code, industry, mcc_risk_score, risk_tier, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       merchant_name = VALUES(merchant_name),
       merchant_mid = VALUES(merchant_mid),
       merchant_country = VALUES(merchant_country),
       authorised_contact_name = COALESCE(VALUES(authorised_contact_name), authorised_contact_name),
       authorised_contact_email = COALESCE(VALUES(authorised_contact_email), authorised_contact_email)`,
    [
      merchantId, merchantName, merchantMid, merchantCountry, authorisedContactName, authorisedContactEmail,
      mccCode, industry, mccRiskScore, riskTier,
    ],
  );
}

async function countFiltered(whereSql, values) {
  const [rows] = await database.query(`SELECT COUNT(*) AS total FROM merchants m ${whereSql}`, values);
  return Number(rows[0]?.total || 0);
}

async function listFiltered(whereSql, values, limit, offset) {
  const [rows] = await database.query(
    `SELECT m.merchant_id, m.merchant_name, m.merchant_mid, m.merchant_country,
            m.mcc_code, m.industry, m.mcc_risk_score, m.risk_tier, m.is_active,
            mc.contact_name, mc.rfi_email, mc.phone_number, mc.store_id AS contact_store_id, mc.status AS contact_status,
            cdd.kyc_status, cdd.verification_date, cdd.next_review_date,
            cdd.expected_monthly_volume, cdd.expected_avg_ticket, cdd.expected_countries,
            cdd.expected_operating_open_hour, cdd.expected_operating_close_hour
     FROM merchants m
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = m.merchant_id
     LEFT JOIN merchant_cdd_profiles cdd ON cdd.merchant_id = m.merchant_id
     ${whereSql} ORDER BY m.merchant_name ASC LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  return rows;
}

async function listDistinctIndustries() {
  const [rows] = await database.query('SELECT DISTINCT industry FROM merchants ORDER BY industry ASC');
  return rows;
}

async function listDistinctMccCodes() {
  const [rows] = await database.query('SELECT DISTINCT mcc_code FROM merchants ORDER BY mcc_code ASC');
  return rows;
}

async function listActiveForDropdown() {
  const [rows] = await database.query('SELECT merchant_id, merchant_name FROM merchants WHERE is_active = 1 ORDER BY merchant_name ASC');
  return rows;
}

async function upsert({
  merchantId, merchantName, mccCode, industry, mccRiskScore, merchantMid, merchantCountry, riskTier, isActive,
}) {
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
  return result;
}

async function updateFields(merchantId, setSql, values) {
  await database.execute(`UPDATE merchants SET ${setSql} WHERE merchant_id = ?`, [...values, merchantId]);
}

async function deleteById(merchantId) {
  await database.execute('DELETE FROM merchants WHERE merchant_id = ?', [merchantId]);
}

module.exports = {
  findRiskSnapshotById,
  findMidById,
  findRiskTierById,
  upsertFromPartnerFeed,
  countFiltered,
  listFiltered,
  listDistinctIndustries,
  listDistinctMccCodes,
  listActiveForDropdown,
  upsert,
  updateFields,
  deleteById,
};
