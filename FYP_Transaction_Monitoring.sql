DROP DATABASE IF EXISTS fyp_transaction_monitoring;
CREATE DATABASE fyp_transaction_monitoring;
USE fyp_transaction_monitoring;

-- Table 1: Merchants
CREATE TABLE merchants (
    merchant_id VARCHAR(20) PRIMARY KEY,
    merchant_name VARCHAR(100) NOT NULL,
    merchant_mid VARCHAR(30) NULL,
    merchant_country VARCHAR(5) NULL,
    authorised_contact_name VARCHAR(100) NULL,
    authorised_contact_email VARCHAR(255) NULL,
    mcc_code VARCHAR(4) NOT NULL,
    industry VARCHAR(100) NOT NULL,
    mcc_risk_score INT NOT NULL DEFAULT 0,
    risk_tier ENUM('Standard', 'High') NOT NULL DEFAULT 'Standard',
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
    assigned_role VARCHAR(40) NULL,
    escalation_destination VARCHAR(40) NULL,
    status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open',
    notes TEXT NULL,
    due_at DATETIME NULL,
    referred_to_stro_at DATETIME NULL,
    referred_to_stro_by VARCHAR(20) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id),
    FOREIGN KEY (assigned_to) REFERENCES users(user_id)
);

CREATE TABLE str_reports (
    str_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    case_id VARCHAR(40) NOT NULL,
    str_status ENUM('Recommended', 'Filed', 'Not Required') NOT NULL DEFAULT 'Recommended',
    reference_number VARCHAR(80) NULL,
    reporting_reason TEXT NULL,
    suspicion_summary TEXT NULL,
    transaction_summary TEXT NULL,
    supporting_evidence TEXT NULL,
    stro_notes TEXT NULL,
    referral_reason VARCHAR(120) NULL,
    referral_summary TEXT NULL,
    senior_analyst_notes TEXT NULL,
    prepared_by VARCHAR(20) NULL,
    filed_by VARCHAR(20) NULL,
    filing_date DATE NULL,
    filed_at DATETIME NULL,
    not_required_reason TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_str_case (case_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE,
    FOREIGN KEY (prepared_by) REFERENCES users(user_id),
    FOREIGN KEY (filed_by) REFERENCES users(user_id)
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
CREATE INDEX idx_cases_due_at ON cases(due_at);
CREATE INDEX idx_cases_assigned_role ON cases(assigned_role);
CREATE INDEX idx_cases_escalation_destination ON cases(escalation_destination);
CREATE INDEX idx_str_reports_transaction ON str_reports(transaction_id);
CREATE INDEX idx_str_reports_status ON str_reports(str_status);

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

-- Users seed data (password: 12345678)
INSERT INTO users (user_id, user_name, user_role, password, is_active)
VALUES
    ('USR-001', 'Ava Lim', 'Analyst', SHA2('12345678', 256), 1),
    ('USR-002', 'Noah Tan', 'Senior Analyst', SHA2('12345678', 256), 1),
    ('USR-003', 'Maya Wong', 'STRO', SHA2('12345678', 256), 1),
    ('USR-004', 'Ethan Koh', 'Admin', SHA2('12345678', 256), 1);

-- Global compliance rules (merchant_id NULL - apply to every merchant). Per-merchant rules are
-- computed from each merchant's own real transaction history at import time instead of being
-- hand-seeded here - see src/lib/testDataSeed.js.
INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
VALUES
    ('TIME-001', NULL, 'Transaction Outside Operating Hours', 'Medium', 'Transaction occurred outside normal merchant operating hours', 10, NULL, NULL, 'operating_hours', 1),
    ('RULE-001', NULL, 'Large local card transaction', 'High', 'Local card transaction equal to or above SGD 10,000', 35, 10000.00, NULL, 'amount', 1),
    ('RULE-002', NULL, 'Contextual jurisdiction escalation', 'High', 'Customer, issuer, or counterparty data references a high-risk jurisdiction', 20, NULL, NULL, 'jurisdiction', 1),
    ('RULE-003', NULL, 'Elevated same-card spend', 'Medium', 'Unusual cumulative spend on the same card within 24 hours', 35, 3000.00, NULL, 'card_spend_24h', 1),
    ('RULE-004', NULL, 'Incomplete customer diligence', 'Medium', 'Customer KYC profile is pending review', 25, NULL, NULL, 'kyc_pending', 1),
    ('RULE-005', NULL, 'Low-value card testing burst', 'High', 'Repeated low-value card payments may indicate card testing', 30, 20.00, 5, 'low_value_burst', 1);
