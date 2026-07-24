const database = require('../src/database');

// Accepts an optional db client (see merchantModel.findRiskTierById) so loadMerchantCddContext's
// injected client/test fake sees the exact same query text through this seam.
async function findProfileByMerchantId(merchantId, db = database) {
  const [rows] = await db.query(
    `SELECT kyc_status, verification_date, next_review_date, expected_avg_ticket,
            expected_monthly_volume, expected_countries,
            expected_operating_open_hour, expected_operating_close_hour
     FROM merchant_cdd_profiles WHERE merchant_id = ? LIMIT 1`,
    [merchantId],
  );
  return rows[0] || null;
}

async function findCddChecklistByTransactionId(transactionId, db = database) {
  const [rows] = await db.query(
    `SELECT business_registration_verified, business_registration_notes, business_registration_by, business_registration_at,
            screening_verified, screening_notes, screening_by, screening_at
     FROM merchant_cdd_checklist WHERE transaction_id = ? LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function findEddChecklistByTransactionId(transactionId, db = database) {
  const [rows] = await db.query(
    `SELECT source_of_funds_verified, source_of_funds_notes, source_of_funds_by, source_of_funds_at,
            site_visit_completed, site_visit_notes, site_visit_by, site_visit_at,
            enhanced_verification_completed, enhanced_verification_notes, enhanced_verification_by, enhanced_verification_at,
            senior_signoff_completed, senior_signoff_notes, senior_signoff_by, senior_signoff_at
     FROM merchant_edd_checklist WHERE transaction_id = ? LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

async function listRecentScreeningRecords(merchantId, limit = 5) {
  const [rows] = await database.query(
    `SELECT screening_id, screening_type, result, screened_against, notes, screened_at
     FROM merchant_screening_records WHERE merchant_id = ? ORDER BY screened_at DESC LIMIT ?`,
    [merchantId, limit],
  );
  return rows;
}

async function listBeneficialOwnersByMerchantIds(merchantIds) {
  if (!merchantIds.length) return [];
  const [rows] = await database.query(
    `SELECT owner_id, merchant_id, full_name, owner_role, ownership_percentage, nationality, id_reference, date_of_birth
     FROM merchant_beneficial_owners WHERE merchant_id IN (?) ORDER BY added_at DESC`,
    [merchantIds],
  );
  return rows;
}

async function listScreeningRecordsByMerchantIds(merchantIds) {
  if (!merchantIds.length) return [];
  const [rows] = await database.query(
    `SELECT screening_id, merchant_id, screening_type, result, screened_against, notes, screened_at
     FROM merchant_screening_records WHERE merchant_id IN (?) ORDER BY screened_at DESC`,
    [merchantIds],
  );
  return rows;
}

async function upsertProfile({
  cddId, merchantId, kycStatus, verificationDate, nextReviewDate, expectedMonthlyVolume,
  expectedAvgTicket, expectedCountries, expectedOperatingOpenHour, expectedOperatingCloseHour, updatedBy,
}) {
  await database.execute(
    `INSERT INTO merchant_cdd_profiles (cdd_id, merchant_id, kyc_status, verification_date, next_review_date, expected_monthly_volume, expected_avg_ticket, expected_countries, expected_operating_open_hour, expected_operating_close_hour, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       kyc_status = VALUES(kyc_status),
       verification_date = VALUES(verification_date),
       next_review_date = VALUES(next_review_date),
       expected_monthly_volume = VALUES(expected_monthly_volume),
       expected_avg_ticket = VALUES(expected_avg_ticket),
       expected_countries = VALUES(expected_countries),
       expected_operating_open_hour = VALUES(expected_operating_open_hour),
       expected_operating_close_hour = VALUES(expected_operating_close_hour),
       updated_by = VALUES(updated_by),
       updated_at = NOW()`,
    [
      cddId, merchantId, kycStatus, verificationDate, nextReviewDate, expectedMonthlyVolume,
      expectedAvgTicket, expectedCountries, expectedOperatingOpenHour, expectedOperatingCloseHour, updatedBy,
    ],
  );
}

async function insertBeneficialOwner({
  ownerId, merchantId, fullName, ownerRole, ownershipPercentage, nationality, idReference, dateOfBirth, addedBy,
}) {
  await database.execute(
    `INSERT INTO merchant_beneficial_owners (owner_id, merchant_id, full_name, owner_role, ownership_percentage, nationality, id_reference, date_of_birth, added_by, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [ownerId, merchantId, fullName, ownerRole, ownershipPercentage, nationality, idReference, dateOfBirth, addedBy],
  );
}

async function deleteBeneficialOwner(ownerId) {
  await database.execute('DELETE FROM merchant_beneficial_owners WHERE owner_id = ?', [ownerId]);
}

async function insertScreeningRecord({
  screeningId, merchantId, screeningType, result, screenedAgainst, notes, screenedBy,
}) {
  await database.execute(
    `INSERT INTO merchant_screening_records (screening_id, merchant_id, screening_type, result, screened_against, notes, screened_by, screened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [screeningId, merchantId, screeningType, result, screenedAgainst, notes, screenedBy],
  );
}

module.exports = {
  findProfileByMerchantId,
  findCddChecklistByTransactionId,
  findEddChecklistByTransactionId,
  listRecentScreeningRecords,
  listBeneficialOwnersByMerchantIds,
  listScreeningRecordsByMerchantIds,
  upsertProfile,
  insertBeneficialOwner,
  deleteBeneficialOwner,
  insertScreeningRecord,
};
