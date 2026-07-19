USE fyp_transaction_monitoring;

-- Add customer email addresses for Request for Information delivery.
-- Existing customer records are preserved.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL AFTER customer_name;
