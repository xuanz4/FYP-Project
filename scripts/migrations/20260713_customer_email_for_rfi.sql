USE fyp_transaction_monitoring;

-- Add customer email addresses for Request for Information delivery.
-- Existing customer records are preserved.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL AFTER customer_name;

UPDATE customers SET email = 'ava.lim@example.com' WHERE customer_id = 'CUS-1001' AND email IS NULL;
UPDATE customers SET email = 'noah.tan@example.com' WHERE customer_id = 'CUS-1002' AND email IS NULL;
UPDATE customers SET email = 'maya.wong@example.com' WHERE customer_id = 'CUS-1003' AND email IS NULL;
UPDATE customers SET email = 'ethan.koh@example.com' WHERE customer_id = 'CUS-1004' AND email IS NULL;
UPDATE customers SET email = 'sophia.chen@example.com' WHERE customer_id = 'CUS-1005' AND email IS NULL;
