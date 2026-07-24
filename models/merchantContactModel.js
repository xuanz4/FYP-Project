const database = require('../src/database');

async function findByMerchantId(merchantId) {
  const [rows] = await database.query(
    'SELECT contact_name, rfi_email, phone_number, store_id FROM merchant_contacts WHERE merchant_id = ? LIMIT 1',
    [merchantId],
  );
  return rows[0] || null;
}

async function upsert({
  contactId, merchantId, merchantMid, storeId, contactName, rfiEmail, phoneNumber, updatedBy,
}) {
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
    [contactId, merchantId, merchantMid, storeId, contactName, rfiEmail, phoneNumber, updatedBy],
  );
}

module.exports = { findByMerchantId, upsert };
