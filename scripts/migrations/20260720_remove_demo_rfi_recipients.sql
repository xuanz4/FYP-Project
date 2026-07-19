USE fyp_transaction_monitoring;

-- Reserved demonstration-domain addresses must never be used for real SMTP delivery.
UPDATE customers
SET email = NULL
WHERE LOWER(email) LIKE '%@example.com';

UPDATE customers
SET authorised_contact_email = NULL
WHERE LOWER(authorised_contact_email) LIKE '%@example.com';
