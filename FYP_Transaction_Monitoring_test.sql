DROP DATABASE IF EXISTS fyp_transaction_monitoring_test;
CREATE DATABASE fyp_transaction_monitoring_test;
USE fyp_transaction_monitoring_test;

-- Table 1: Merchants
CREATE TABLE merchants (
    merchant_id VARCHAR(20) PRIMARY KEY,
    merchant_name VARCHAR(100) NOT NULL,
    mcc_code VARCHAR(4) NOT NULL,
    industry VARCHAR(100) NOT NULL,
    mcc_risk_score INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1
);

-- Table 2: Users (updated)
-- Roles: Admin manages users/rules/merchants only. Analyst and Senior Analyst work
-- cases; STRO resolves escalations. See app.js requireRole() usage for what each can do.
CREATE TABLE users (
    user_id VARCHAR(20) PRIMARY KEY,
    user_name VARCHAR(100) NOT NULL,
    user_role ENUM('Analyst', 'Senior Analyst', 'STRO', 'Admin') NOT NULL,
    password VARCHAR(255) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
);

-- Table 3: Compliance Rules
CREATE TABLE compliance_rules (
    rule_id VARCHAR(30) PRIMARY KEY,
    merchant_id VARCHAR(20) NULL,
    rule_name VARCHAR(150) NOT NULL,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL,
    reason VARCHAR(255) NOT NULL,
    weight INT NOT NULL,
    amount_threshold DECIMAL(10,2) NULL,
    count_threshold INT NULL,
    rule_type VARCHAR(80) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);

-- Table 4: Transactions
CREATE TABLE transactions (
    transaction_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    card_number VARCHAR(20) NOT NULL,
    card_expiry VARCHAR(5) NOT NULL,
    bin_range VARCHAR(6) NOT NULL,
    cvv VARCHAR(4) NOT NULL,
    bank_issuer VARCHAR(100) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    transaction_code VARCHAR(40) NULL,
    risk_score INT NOT NULL DEFAULT 0,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
    status ENUM('Cleared', 'Flagged') NOT NULL DEFAULT 'Cleared',
    action_status ENUM('None', 'Pending RFI', 'Pending Senior Review', 'STR Filed', 'Dismissed as False Positive', 'Escalated') NOT NULL DEFAULT 'None',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);

-- Table 5: Transaction Matched Rules
CREATE TABLE transaction_matched_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    rule_id VARCHAR(30) NOT NULL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES compliance_rules(rule_id),
    UNIQUE KEY uniq_transaction_rule (transaction_id, rule_id)
);

-- Table 6: Audit Logs
-- Append-only: see triggers below that reject any UPDATE/DELETE against this table.
CREATE TABLE audit_logs (
    audit_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NULL,
    entity_type VARCHAR(40) NULL,
    entity_id VARCHAR(40) NULL,
    action VARCHAR(120) NOT NULL,
    user_id VARCHAR(20) NULL,
    notes TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Table: cases
-- 'Pending Senior Review' is Scenario 2 of the escalation flow (Analyst -> Senior Analyst
-- -> STRO): high-severity cases stop here before a Senior Analyst confirms and forwards to
-- STRO. Standard-severity cases (Scenario 1) skip this and go straight to 'Escalated'.
-- created_by is nullable because cases are opened automatically by the
-- transactions_auto_case_insert/update triggers below, not by a human - there is no
-- manual "open case" action anywhere in the app.
CREATE TABLE cases (
    case_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    created_by VARCHAR(20) NULL,
    assigned_to VARCHAR(20) NULL,
    status ENUM('Open', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed') NOT NULL DEFAULT 'Open',
    notes TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id),
    FOREIGN KEY (assigned_to) REFERENCES users(user_id)
);

-- Indexes
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_risk_level ON transactions(risk_level);
CREATE INDEX idx_transactions_action_status ON transactions(action_status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_audit_logs_transaction ON audit_logs(transaction_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_compliance_rules_merchant ON compliance_rules(merchant_id);
CREATE INDEX idx_cases_transaction ON cases(transaction_id);
CREATE INDEX idx_cases_created_by ON cases(created_by);
CREATE INDEX idx_cases_assigned_to ON cases(assigned_to);
CREATE INDEX idx_cases_status ON cases(status);

DELIMITER $$

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only and cannot be modified';
END$$

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only and cannot be deleted';
END$$

-- Cases are never opened manually - these triggers open one automatically (and log it)
-- the moment a transaction's status becomes 'Flagged', whether that happens on insert
-- (the normal path) or via a later update.
CREATE TRIGGER transactions_auto_case_insert
AFTER INSERT ON transactions
FOR EACH ROW
BEGIN
    IF NEW.status = 'Flagged' THEN
        INSERT INTO cases (case_id, transaction_id, created_by, assigned_to, status, notes)
        VALUES (CONCAT('CASE-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 1000000)), NEW.transaction_id, NULL, NULL, 'Open', 'Automatically opened - transaction flagged by risk engine');
        INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
        VALUES (CONCAT('AUD-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 1000000)), NEW.transaction_id, 'Case Auto-Opened', NULL, 'System opened a case after this transaction was flagged', NOW());
    END IF;
END$$

CREATE TRIGGER transactions_auto_case_update
AFTER UPDATE ON transactions
FOR EACH ROW
BEGIN
    IF NEW.status = 'Flagged' AND OLD.status <> 'Flagged' AND NOT EXISTS (SELECT 1 FROM cases WHERE transaction_id = NEW.transaction_id) THEN
        INSERT INTO cases (case_id, transaction_id, created_by, assigned_to, status, notes)
        VALUES (CONCAT('CASE-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 1000000)), NEW.transaction_id, NULL, NULL, 'Open', 'Automatically opened - transaction flagged by risk engine');
        INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
        VALUES (CONCAT('AUD-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 1000000)), NEW.transaction_id, 'Case Auto-Opened', NULL, 'System opened a case after this transaction was flagged', NOW());
    END IF;
END$$

DELIMITER ;

-- =====================================================
-- SEED DATA
-- =====================================================

-- Merchants
INSERT INTO merchants (merchant_id, merchant_name, mcc_code, industry, mcc_risk_score, is_active)
VALUES
    ('MERCH-A', 'Family Clothing Store (MCC 5651)', '5651', 'Family Clothing Stores', 8, 1),
    ('MERCH-B', 'Shoe Store (MCC 5661)', '5661', 'Shoe Stores', 12, 1),
    ('MERCH-C', 'Cosmetic Store (MCC 5977)', '5977', 'Cosmetic Stores', 10, 1);

-- Users seed data (password: 12345678)
INSERT INTO users (user_id, user_name, user_role, password, is_active)
VALUES
    ('USR-001', 'Ava Lim', 'Analyst', SHA2('12345678', 256), 1),
    ('USR-002', 'Noah Tan', 'Senior Analyst', SHA2('12345678', 256), 1),
    ('USR-003', 'Maya Wong', 'STRO', SHA2('12345678', 256), 1),
    ('USR-004', 'Ethan Koh', 'Admin', SHA2('12345678', 256), 1);

-- Compliance Rules (adapted from old schema)
INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
VALUES
    -- Merchant A rules
    ('COM-A-001', 'MERCH-A', 'Single transaction above S$700', 'Medium', 'Above this merchant''s typical basket size', 30, 700.00, NULL, 'amount', 1),
    ('COM-A-002', 'MERCH-A', 'Single transaction above S$1,200', 'High', 'Far above this merchant''s typical basket size', 55, 1200.00, NULL, 'amount', 1),
    ('COM-A-003', 'MERCH-A', '4+ transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 4, 'recent_merchant_transactions', 1),
    ('COM-A-004', 'MERCH-A', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant', 55, 1500.00, NULL, 'card_spend_24h', 1),
    ('COM-A-005', 'MERCH-A', 'Several amounts just below S$700', 'Medium', 'Possible threshold avoidance', 30, 700.00, 3, 'near_threshold', 1),
    ('COM-A-006', 'MERCH-A', 'New or usually low-spend customer above S$800', 'Medium', 'New card or sudden spend jump with high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer', 1),
    -- Merchant B rules
    ('COM-B-001', 'MERCH-B', 'Single transaction above S$1,000', 'Medium', 'Above this merchant''s typical basket size', 30, 1000.00, NULL, 'amount', 1),
    ('COM-B-002', 'MERCH-B', 'Single transaction above S$2,000', 'High', 'Far above this merchant''s typical basket size', 55, 2000.00, NULL, 'amount', 1),
    ('COM-B-003', 'MERCH-B', '3+ transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 3, 'recent_merchant_transactions', 1),
    ('COM-B-004', 'MERCH-B', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant', 55, 1500.00, NULL, 'card_spend_24h', 1),
    ('COM-B-005', 'MERCH-B', 'Several amounts just below S$1,000', 'Medium', 'Possible threshold avoidance', 30, 1000.00, 3, 'near_threshold', 1),
    ('COM-B-006', 'MERCH-B', 'New or usually low-spend customer above S$800', 'Medium', 'New card or sudden spend jump with high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer', 1),
    -- Merchant C rules
    ('COM-C-001', 'MERCH-C', 'Single transaction above S$700', 'Medium', 'Above this merchant''s typical basket size', 30, 700.00, NULL, 'amount', 1),
    ('COM-C-002', 'MERCH-C', 'Single transaction above S$1,000', 'High', 'Far above this merchant''s typical basket size', 55, 1000.00, NULL, 'amount', 1),
    ('COM-C-003', 'MERCH-C', '4+ transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 4, 'recent_merchant_transactions', 1),
    ('COM-C-004', 'MERCH-C', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant', 55, 1500.00, NULL, 'card_spend_24h', 1),
    ('COM-C-005', 'MERCH-C', 'Several amounts just below S$700', 'Medium', 'Possible threshold avoidance', 30, 700.00, 3, 'near_threshold', 1),
    ('COM-C-006', 'MERCH-C', 'New or usually low-spend customer above S$800', 'Medium', 'New card or sudden spend jump with high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer', 1),
    -- Global rules (apply to all merchants)
    ('TIME-001', NULL, 'Transaction Outside Operating Hours', 'Medium', 'Transaction occurred outside normal merchant operating hours', 10, NULL, NULL, 'operating_hours', 1),
    ('RULE-001', NULL, 'Large local card transaction', 'High', 'Local card transaction equal to or above SGD 10,000', 35, 10000.00, NULL, 'amount', 1),
    ('RULE-002', NULL, 'Contextual jurisdiction escalation', 'High', 'Customer, issuer, or counterparty data references a high-risk jurisdiction', 20, NULL, NULL, 'jurisdiction', 1),
    ('RULE-003', NULL, 'Elevated same-card spend', 'Medium', 'Unusual cumulative spend on the same card within 24 hours', 35, 3000.00, NULL, 'card_spend_24h', 1),
    ('RULE-004', NULL, 'Incomplete customer diligence', 'Medium', 'Customer KYC profile is pending review', 25, NULL, NULL, 'kyc_pending', 1),
    ('RULE-005', NULL, 'Low-value card testing burst', 'High', 'Repeated low-value card payments may indicate card testing', 30, 20.00, 5, 'low_value_burst', 1);

-- Transactions
INSERT INTO transactions (transaction_id, merchant_id, card_number, card_expiry, bin_range, cvv, bank_issuer, amount, transaction_code, risk_score, risk_level, status, action_status, created_at)
VALUES
    -- Cleared transaction
    ('TXN-001', 'MERCH-A', '4123456789012345', '12/27', '412345', '123', 'DBS Bank', 95.00, 'TXNREF-001', 8, 'Low', 'Cleared', 'None', '2026-07-14 14:00:00'),
    -- Flagged Critical - needs action
    ('TXN-002', 'MERCH-B', '5123456789012345', '06/26', '512345', '456', 'OCBC Bank', 2150.00, 'TXNREF-002', 277, 'Critical', 'Flagged', 'None', '2026-07-14 02:00:00'),
    -- Flagged Critical - under review
    ('TXN-003', 'MERCH-C', '4789123456789012', '09/25', '478912', '789', 'UOB', 880.00, 'TXNREF-003', 165, 'Critical', 'Flagged', 'Pending RFI', '2026-07-14 14:00:00'),
    -- Flagged High
    ('TXN-004', 'MERCH-A', '4234567890123456', '03/28', '423456', '321', 'DBS Bank', 750.00, 'TXNREF-004', 55, 'High', 'Flagged', 'None', '2026-07-14 10:30:00'),
    -- Another Critical - oldest one
    ('TXN-005', 'MERCH-A', '4012345678901234', '11/26', '401234', '654', 'Citibank', 1300.00, 'TXNREF-005', 220, 'Critical', 'Flagged', 'None', '2026-07-13 23:00:00');

-- Transaction Matched Rules
INSERT INTO transaction_matched_rules (transaction_id, rule_id)
VALUES
    -- TXN-001: Low risk, only one rule fired
    ('TXN-001', 'COM-A-001'),
    -- TXN-002: Critical - multiple rules
    ('TXN-002', 'COM-B-001'),
    ('TXN-002', 'COM-B-002'),
    ('TXN-002', 'COM-B-004'),
    ('TXN-002', 'TIME-001'),
    ('TXN-002', 'RULE-001'),
    -- TXN-003: Critical - multiple rules
    ('TXN-003', 'COM-C-001'),
    ('TXN-003', 'COM-C-003'),
    ('TXN-003', 'COM-C-006'),
    ('TXN-003', 'RULE-004'),
    -- TXN-004: High
    ('TXN-004', 'COM-A-001'),
    ('TXN-004', 'COM-A-002'),
    -- TXN-005: Critical - oldest
    ('TXN-005', 'COM-A-002'),
    ('TXN-005', 'COM-A-004'),
    ('TXN-005', 'RULE-003');

-- Audit Logs
INSERT INTO audit_logs (audit_id, transaction_id, action, user_id, notes, created_at)
VALUES
    ('AUD-001', 'TXN-002', 'Transaction Flagged', 'USR-001', 'System flagged - Critical risk score 277', '2026-07-14 02:00:00'),
    ('AUD-002', 'TXN-003', 'Transaction Flagged', 'USR-001', 'System flagged - Critical risk score 165', '2026-07-14 14:00:00'),
    ('AUD-003', 'TXN-003', 'RFI Requested', 'USR-001', 'Requesting further information from merchant', '2026-07-14 14:15:00'),
    ('AUD-004', 'TXN-004', 'Transaction Flagged', 'USR-002', 'System flagged - High risk score 55', '2026-07-14 10:30:00'),
    ('AUD-005', 'TXN-005', 'Transaction Flagged', 'USR-002', 'System flagged - Critical risk score 220', '2026-07-13 23:00:00'),
    ('AUD-006', 'TXN-004', 'Case Auto-Opened', NULL, 'System opened a case after this transaction was flagged', '2026-07-14 10:30:00');

-- CASE-002/003 use human created_by values as historical seed flavor (as if an analyst had
-- already been working them); CASE-004 shows the actual system-opened shape every new case
-- gets today, via the transactions_auto_case_insert/update triggers above.
INSERT INTO cases (case_id, transaction_id, created_by, assigned_to, status, notes, created_at)
VALUES
    ('CASE-001', 'TXN-003', 'USR-001', NULL, 'Pending RFI', 'Requesting additional merchant info', '2026-07-14 14:15:00'),
    ('CASE-002', 'TXN-002', 'USR-002', NULL, 'Open', NULL, '2026-07-14 10:00:00'),
    ('CASE-003', 'TXN-005', 'USR-001', 'USR-003', 'Escalated', 'Escalating due to high risk score and multiple rule matches', '2026-07-14 09:00:00'),
    ('CASE-004', 'TXN-004', NULL, NULL, 'Open', 'Automatically opened - transaction flagged by risk engine', '2026-07-14 10:30:00');
