USE fyp_transaction_monitoring_test;

-- Minimal SMTP-only RFI recipient storage for the active merchant transaction schema.
-- Values remain NULL until an administrator saves a real authorised contact.
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS authorised_contact_name VARCHAR(100) NULL AFTER merchant_country,
  ADD COLUMN IF NOT EXISTS authorised_contact_email VARCHAR(255) NULL AFTER authorised_contact_name;
