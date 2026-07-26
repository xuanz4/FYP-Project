-- =====================================================
-- FYP Transaction Monitoring — Full Database Schema
--
-- Single source of truth for the physical schema (21 tables). Consolidates what
-- used to be split across three places: this file (originally 8 tables), the
-- idempotent ensure*() migrations in src/lib/schema.js, and
-- scripts/migrations/20260724_rfi_notifications.sql (now removed - its two
-- tables, rfi_requests and notifications, are defined below instead).
--
-- src/lib/schema.js's ensure*() functions still run on every server start and
-- remain safe to keep: each one checks INFORMATION_SCHEMA or uses
-- CREATE TABLE IF NOT EXISTS before acting, so against a database created from
-- this file they simply find everything already in place and do nothing. They
-- stay in place to keep older, partially-migrated databases (e.g. a teammate's
-- existing local DB) working without a manual migration step.
-- =====================================================

DROP DATABASE IF EXISTS `soi-2026-2610-0031-xuanzheng`;
CREATE DATABASE `soi-2026-2610-0031-xuanzheng`;
USE `soi-2026-2610-0031-xuanzheng`;

-- =====================================================
-- CORE TABLES
-- =====================================================

-- Table 1: Merchants
-- authorised_contact_name/authorised_contact_email are the original contact fields, still
-- written on merchant creation (see models/merchantModel.js). merchant_contacts (below) is the
-- live, auditable source the RFI workflow and transaction detail page actually read from - a
-- one-time backfill copies these two columns into merchant_contacts the first time the app runs.
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

-- Table 2: Users
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
-- final_risk_score/final_risk_level and the three *_contribution columns hold the additive risk
-- breakdown (MCC + Profile + Detection) used by the risk-scoring engine and the transaction
-- detail page - see src/riskEngine.js.
CREATE TABLE transactions (
    transaction_id VARCHAR(40) PRIMARY KEY,
    unique_transaction_reference VARCHAR(50) NULL,
    merchant_id VARCHAR(20) NOT NULL,
    store_id VARCHAR(30) NULL,
    amount DECIMAL(10,2) NOT NULL,
    method VARCHAR(20) NULL,
    scheme VARCHAR(20) NULL,
    issuer_country VARCHAR(5) NULL,
    issuer_bank VARCHAR(100) NULL,
    card_bin VARCHAR(8) NULL,
    card_last4 CHAR(4) NULL,
    card_ref VARCHAR(64) NULL,
    cvv_validation_result VARCHAR(20) NULL,
    expiry_validation_result VARCHAR(20) NULL,
    transaction_code VARCHAR(40) NULL,
    transaction_type VARCHAR(20) NULL,
    entry_mode VARCHAR(20) NULL,
    payment_status VARCHAR(20) NULL,
    payment_status_label VARCHAR(30) NULL,
    payment_status_tone VARCHAR(20) NULL,
    net DECIMAL(10,2) NULL,
    fee DECIMAL(10,2) NULL,
    txn_time DATETIME NULL,
    source_note VARCHAR(255) NULL,
    risk_score INT NOT NULL DEFAULT 0,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
    final_risk_score INT NULL,
    final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL,
    mcc_risk_contribution INT NULL,
    profile_risk_contribution INT NULL,
    transaction_detection_contribution INT NULL,
    status ENUM('Cleared', 'Flagged') NOT NULL DEFAULT 'Cleared',
    action_status ENUM('None', 'Pending RFI', 'Pending Senior Review', 'STR Filed', 'Dismissed as False Positive', 'Escalated', 'Resolved') NOT NULL DEFAULT 'None',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
    -- Named explicitly (rather than an inline UNIQUE, which MySQL would auto-name
    -- "unique_transaction_reference") so it matches the index name
    -- src/lib/schema.js's ensureRiskContributionColumns looks for by name. If the names
    -- didn't match, that check would add a second, redundant unique index on this column.
    UNIQUE KEY uniq_unique_transaction_reference (unique_transaction_reference),
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

-- Table 7: Cases
-- 'Pending Senior Review' is Scenario 2 of the escalation flow (Analyst -> Senior Analyst
-- -> STRO): high-severity cases stop here before a Senior Analyst confirms and forwards to
-- STRO. Standard-severity cases (Scenario 1) skip this and go straight to 'Escalated'.
-- created_by is nullable because cases are opened automatically by the
-- transactions_auto_case_insert/update triggers below, not by a human - there is no
-- manual "open case" action anywhere in the app.
-- decision/resolution_reason/analyst_notes/resolved_at/resolved_by hold the Required Resolution
-- Information for case resolution; last_actioned_by/at track whoever most recently took any
-- action on the case (assign, RFI, escalate, refer, STR file, resolve); manual_*_contribution/
-- discrepancy_flag/discrepancy_notes hold the resolver's optional manual reconciliation against
-- the automated risk score.
CREATE TABLE cases (
    case_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    created_by VARCHAR(20) NULL,
    assigned_to VARCHAR(20) NULL,
    last_actioned_by VARCHAR(20) NULL,
    last_actioned_at DATETIME NULL,
    assigned_role VARCHAR(40) NULL,
    escalation_destination VARCHAR(40) NULL,
    status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open',
    notes TEXT NULL,
    decision VARCHAR(40) NULL,
    resolution_reason VARCHAR(120) NULL,
    analyst_notes TEXT NULL,
    resolved_at DATETIME NULL,
    resolved_by VARCHAR(40) NULL,
    manual_mcc_contribution INT NULL,
    manual_profile_contribution INT NULL,
    manual_detection_contribution INT NULL,
    manual_final_score INT NULL,
    discrepancy_flag TINYINT(1) NULL,
    discrepancy_notes TEXT NULL,
    due_at DATETIME NULL,
    referred_to_stro_at DATETIME NULL,
    referred_to_stro_by VARCHAR(20) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id),
    FOREIGN KEY (assigned_to) REFERENCES users(user_id)
);

-- Table 8: STR Reports
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

-- Table 9: Case Escalation History
-- Preserves who worked a case before each escalation wipes cases.assigned_to - lets
-- hasCaseAccess() (models/caseModel.js) keep the original Analyst able to see a case's RFI reply
-- lookup after it's escalated. escalated_by is nullable because the overdue-CDD auto-referral
-- sweep (transactionsController.js's autoReferOverdueCddCases) routes cases with no human actor,
-- same "System" convention audit_logs.user_id already uses.
CREATE TABLE case_escalation_history (
    history_id VARCHAR(40) PRIMARY KEY,
    case_id VARCHAR(40) NOT NULL,
    from_user_id VARCHAR(20) NULL,
    from_role VARCHAR(40) NULL,
    to_role VARCHAR(40) NOT NULL,
    escalated_by VARCHAR(20) NULL,
    escalated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_case_escalation_history_case (case_id),
    FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Table 10: Merchant Risk Profiles
-- One row per merchant MID summarising that merchant's transaction history, so "Profile Risk"
-- is a real computed number. Written after each transaction is ingested; read by the risk
-- engine for the next transaction's profile risk contribution.
CREATE TABLE merchant_risk_profiles (
    merchant_mid VARCHAR(30) PRIMARY KEY,
    merchant_id VARCHAR(20) NULL,
    merchant_name VARCHAR(100) NULL,
    transaction_count INT NOT NULL DEFAULT 0,
    flagged_transaction_count INT NOT NULL DEFAULT 0,
    flagged_transaction_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    declined_transaction_count INT NOT NULL DEFAULT 0,
    total_transaction_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    average_transaction_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    maximum_transaction_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    rule_trigger_count INT NOT NULL DEFAULT 0,
    escalation_count INT NOT NULL DEFAULT 0,
    confirmed_suspicious_case_count INT NOT NULL DEFAULT 0,
    profile_risk_score INT NOT NULL DEFAULT 0,
    profile_risk_level VARCHAR(30) NOT NULL DEFAULT 'Insufficient History',
    profile_risk_reasons TEXT NULL,
    first_seen_at DATETIME NULL,
    last_seen_at DATETIME NULL,
    risk_last_calculated_at DATETIME NULL,
    INDEX idx_merchant_risk_profiles_merchant_id (merchant_id)
);

-- Table 11: Merchant Contacts
-- Auditable merchant contact record. This is the live source the RFI workflow and transaction
-- detail page read from - an Admin's edit here takes effect immediately.
CREATE TABLE merchant_contacts (
    contact_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    merchant_mid VARCHAR(30) NULL,
    store_id VARCHAR(30) NULL,
    contact_name VARCHAR(100) NULL,
    rfi_email VARCHAR(255) NULL,
    phone_number VARCHAR(30) NULL,
    status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
    updated_by VARCHAR(20) NULL,
    updated_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_merchant_contacts_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
);

-- Table 12: Merchant CDD Profiles
-- CDD baseline (KYC Status, Verification Date, Next Review Date, Expected Monthly Volume,
-- Expected Average Ticket, Expected Countries, Expected Operating Hours). Self-declared/
-- admin-entered - there is no live KYC/sanctions API in this project's scope.
CREATE TABLE merchant_cdd_profiles (
    cdd_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    kyc_status ENUM('Not Started', 'Pending', 'Verified', 'Rejected') NOT NULL DEFAULT 'Not Started',
    verification_date DATE NULL,
    next_review_date DATE NULL,
    expected_monthly_volume DECIMAL(14,2) NULL,
    expected_avg_ticket DECIMAL(10,2) NULL,
    expected_countries VARCHAR(255) NULL,
    expected_operating_open_hour TINYINT NULL,
    expected_operating_close_hour TINYINT NULL,
    updated_by VARCHAR(20) NULL,
    updated_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_merchant_cdd_profiles_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
);

-- Table 13: Merchant Beneficial Owners
-- Append-only. Self-declared, not independently verified - id_reference/nationality are
-- free-text exactly so the UI can label them as such.
CREATE TABLE merchant_beneficial_owners (
    owner_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    owner_role ENUM('Beneficial Owner', 'Authorised Representative', 'Director') NOT NULL DEFAULT 'Beneficial Owner',
    ownership_percentage DECIMAL(5,2) NULL,
    nationality VARCHAR(60) NULL,
    id_reference VARCHAR(80) NULL,
    date_of_birth DATE NULL,
    added_by VARCHAR(20) NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_merchant_beneficial_owners_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
);

-- Table 14: Merchant Screening Records
-- Append-only manual sanctions/PEP/adverse-media attestation log, not a live API match -
-- screened_against is a free-text source note.
CREATE TABLE merchant_screening_records (
    screening_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    screening_type ENUM('Sanctions', 'PEP', 'Adverse Media') NOT NULL,
    result ENUM('Clear', 'Potential Match', 'Confirmed Match') NOT NULL,
    screened_against VARCHAR(150) NULL,
    notes TEXT NULL,
    screened_by VARCHAR(20) NULL,
    screened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_merchant_screening_records_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
);

-- Table 15: Merchant CDD Documents
-- Supporting evidence files for the CDD baseline / EDD checklist / screening records. Stored on
-- local disk under uploads/cdd/, never under /public, so a file is only reachable through the
-- authenticated download route.
CREATE TABLE merchant_cdd_documents (
    document_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    transaction_id VARCHAR(40) NULL,
    case_id VARCHAR(40) NULL,
    document_type ENUM('Business Registration', 'Screening', 'Source of Funds', 'Site Visit', 'Enhanced Verification', 'Other') NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    stored_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size INT NOT NULL,
    notes TEXT NULL,
    uploaded_by VARCHAR(20) NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_merchant_cdd_documents_merchant (merchant_id),
    INDEX idx_merchant_cdd_documents_transaction (transaction_id),
    INDEX idx_merchant_cdd_documents_case (case_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Table 16: Merchant EDD Checklist
-- One row per transaction's case (never shared across sibling transactions of the same
-- merchant). senior_signoff_* is the Senior Sign-off and is only ever written by a Senior
-- Analyst/Admin write path, never by the Analyst-scoped endpoint.
CREATE TABLE merchant_edd_checklist (
    transaction_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    source_of_funds_verified TINYINT(1) NOT NULL DEFAULT 0,
    source_of_funds_notes TEXT NULL,
    source_of_funds_by VARCHAR(20) NULL,
    source_of_funds_at DATETIME NULL,
    site_visit_completed TINYINT(1) NOT NULL DEFAULT 0,
    site_visit_notes TEXT NULL,
    site_visit_by VARCHAR(20) NULL,
    site_visit_at DATETIME NULL,
    enhanced_verification_completed TINYINT(1) NOT NULL DEFAULT 0,
    enhanced_verification_notes TEXT NULL,
    enhanced_verification_by VARCHAR(20) NULL,
    enhanced_verification_at DATETIME NULL,
    senior_signoff_completed TINYINT(1) NOT NULL DEFAULT 0,
    senior_signoff_notes TEXT NULL,
    senior_signoff_by VARCHAR(20) NULL,
    senior_signoff_at DATETIME NULL,
    INDEX idx_merchant_edd_checklist_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE
);

-- Table 17: Merchant CDD Checklist
-- Baseline due-diligence steps every transaction's case must clear, regardless of risk level.
-- The two steps mirror the Analyst-uploadable document types ('Business Registration',
-- 'Screening'): uploading the document is separate evidence, this table is the analyst's
-- explicit confirmation that it was checked.
CREATE TABLE merchant_cdd_checklist (
    transaction_id VARCHAR(40) PRIMARY KEY,
    merchant_id VARCHAR(20) NOT NULL,
    business_registration_verified TINYINT(1) NOT NULL DEFAULT 0,
    business_registration_notes TEXT NULL,
    business_registration_by VARCHAR(20) NULL,
    business_registration_at DATETIME NULL,
    screening_verified TINYINT(1) NOT NULL DEFAULT 0,
    screening_notes TEXT NULL,
    screening_by VARCHAR(20) NULL,
    screening_at DATETIME NULL,
    INDEX idx_merchant_cdd_checklist_merchant (merchant_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE
);

-- Table 18: Case RFI Evidence
-- Evidence Checklist entries recorded when referring a case (RFI reply reviewed, document
-- reference, analyst finding, other).
CREATE TABLE case_rfi_evidence (
    evidence_id VARCHAR(40) PRIMARY KEY,
    case_id VARCHAR(40) NOT NULL,
    transaction_id VARCHAR(40) NOT NULL,
    evidence_type ENUM('RFI Reply Reviewed', 'Document Reference', 'Analyst Finding', 'Other') NOT NULL,
    description TEXT NOT NULL,
    mailbox_reference VARCHAR(255) NULL,
    recorded_by VARCHAR(20) NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_case_rfi_evidence_case (case_id),
    FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Table 19: RFI Email Receipts
-- Records each mailbox reply once, keyed by a Message-ID or content-hash fingerprint, so
-- repeated "Load Response" checks cannot create duplicate receipt audit entries.
CREATE TABLE rfi_email_receipts (
    receipt_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    case_id VARCHAR(40) NOT NULL,
    message_fingerprint CHAR(64) NOT NULL,
    mailbox_reference VARCHAR(255) NULL,
    sender VARCHAR(255) NULL,
    subject VARCHAR(255) NULL,
    email_date VARCHAR(255) NULL,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rfi_email_receipt (transaction_id, message_fingerprint),
    INDEX idx_rfi_email_receipt_case (case_id),
    FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Table 20: RFI Requests
CREATE TABLE rfi_requests (
    rfi_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    case_id VARCHAR(40) NULL,
    sent_by VARCHAR(20) NOT NULL,
    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    request_summary TEXT NULL,
    status ENUM('Sent', 'Failed', 'Replied') NOT NULL,
    outbound_message_id VARCHAR(255) NULL,
    sent_at DATETIME NULL,
    failure_code VARCHAR(80) NULL,
    failure_message VARCHAR(500) NULL,
    reply_message_id VARCHAR(255) NULL,
    reply_sender VARCHAR(255) NULL,
    reply_subject VARCHAR(255) NULL,
    replied_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_rfi_requests_waiting (status, sent_at),
    INDEX idx_rfi_requests_transaction (transaction_id),
    INDEX idx_rfi_requests_case (case_id)
);

-- Table 21: Notifications
-- Powers the role dashboards' and working queue's real-time/live-update indicators.
CREATE TABLE notifications (
    notification_id VARCHAR(40) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    case_id VARCHAR(40) NULL,
    transaction_id VARCHAR(40) NULL,
    rfi_id VARCHAR(40) NULL,
    reply_fingerprint CHAR(64) NULL,
    notification_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    target_url VARCHAR(500) NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME NULL,
    INDEX idx_notifications_user_unread (user_id, is_read, created_at),
    UNIQUE KEY uq_notification_reply_user (user_id, rfi_id, notification_type, reply_fingerprint)
);

-- =====================================================
-- INDEXES (core tables)
-- =====================================================
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

-- =====================================================
-- TRIGGERS
-- =====================================================
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
    ('RULE-005', NULL, 'Low-value card testing burst', 'High', 'Repeated low-value card payments may indicate card testing', 30, 20.00, 5, 'low_value_burst', 1),
    -- These three used to be seeded at runtime by src/lib/schema.js with random rule_ids the
    -- first time the server started. Given fixed ids here so a fresh database matches the
    -- live one from the very first run.
    ('RULE-006', NULL, 'CDD Review Overdue', 'Medium', 'Merchant''s CDD/EDD review date has passed without a completed re-review', 15, NULL, NULL, 'cdd_review_overdue', 1),
    ('RULE-007', NULL, 'CVV check failed', 'Medium', 'The card''s CVV did not match on authorisation', 20, NULL, NULL, 'cvv_check_failed', 1),
    ('RULE-008', NULL, 'Card expiry check failed', 'Medium', 'The card''s expiry date did not match on authorisation', 15, NULL, NULL, 'expiry_check_failed', 1);
