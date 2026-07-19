USE fyp_transaction_monitoring;

-- Support individual and organisation RFI recipients without changing existing transaction links.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS account_type ENUM('Individual', 'Organisation') NOT NULL DEFAULT 'Individual' AFTER email,
  ADD COLUMN IF NOT EXISTS authorised_contact_name VARCHAR(100) NULL AFTER account_type,
  ADD COLUMN IF NOT EXISTS authorised_contact_email VARCHAR(255) NULL AFTER authorised_contact_name;

UPDATE customers
SET account_type = 'Individual'
WHERE account_type IS NULL;
