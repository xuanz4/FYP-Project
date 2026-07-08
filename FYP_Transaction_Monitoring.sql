-- UNIWEB local (domestic) card-payment monitoring schema for Singapore merchants.
-- Merchant risk is assessed via MCC code (industry_risk_score) and merchant_risk_level;
-- monitoring rules are merchant-agnostic and apply to any merchant profile, not just the
-- example companyA/B/C rows seeded below. Scope is local card payments only.
DROP DATABASE IF EXISTS fyp_transaction_monitoring;
CREATE DATABASE fyp_transaction_monitoring;
USE fyp_transaction_monitoring;

CREATE TABLE companies (
    company_id VARCHAR(20) PRIMARY KEY,
    company_name VARCHAR(100) NOT NULL,
    merchant_type VARCHAR(100) NOT NULL,
    mcc_code VARCHAR(4) NOT NULL,
    industry VARCHAR(100) NOT NULL,
    industry_risk_score INT NOT NULL DEFAULT 0,
    merchant_risk_level ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW',
    accent VARCHAR(30) NOT NULL
);

CREATE TABLE customers (
    customer_id VARCHAR(30) PRIMARY KEY,
    customer_name VARCHAR(100) NOT NULL,
    segment VARCHAR(80) NOT NULL,
    kyc_status VARCHAR(80) NOT NULL,
    customer_risk_level ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW'
);

CREATE TABLE compliance_rules (
    rule_id VARCHAR(30) PRIMARY KEY,
    company_id VARCHAR(20) NOT NULL,
    rule_name VARCHAR(150) NOT NULL,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL,
    reason VARCHAR(255) NOT NULL,
    weight INT NOT NULL,
    amount_threshold DECIMAL(10,2) NULL,
    count_threshold INT NULL,
    rule_type VARCHAR(80) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    FOREIGN KEY (company_id) REFERENCES companies(company_id)
);

CREATE TABLE transactions (
    transaction_id VARCHAR(40) PRIMARY KEY,
    company_id VARCHAR(20) NOT NULL,
    customer_id VARCHAR(30) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'SGD',
    country VARCHAR(80) NOT NULL,
    merchant_category VARCHAR(80) NOT NULL,
    recent_company_transactions INT NOT NULL DEFAULT 0,
    card_spend_24h DECIMAL(10,2) NOT NULL DEFAULT 0,
    near_threshold_count INT NOT NULL DEFAULT 0,
    low_value_burst_count INT NOT NULL DEFAULT 0,
    is_new_customer TINYINT(1) NOT NULL DEFAULT 0,
    usual_spend_below_100 TINYINT(1) NOT NULL DEFAULT 0,
    channel VARCHAR(50) NOT NULL,
    direction ENUM('Sale', 'Refund') NOT NULL,
    counterparty_name VARCHAR(120) NULL,
    counterparty_country VARCHAR(80) NULL,
    payment_reference VARCHAR(255) NULL,
    screening_status ENUM('Clear', 'Potential Match') NOT NULL DEFAULT 'Clear',
    status ENUM('Screening', 'Cleared', 'Flagged') NOT NULL DEFAULT 'Screening',
    transaction_hour INT NULL,
    operating_hours_triggered TINYINT(1) NOT NULL DEFAULT 0,
    mcc_risk_score INT NOT NULL DEFAULT 0,
    profile_risk_score INT NOT NULL DEFAULT 0,
    transaction_detection_score INT NOT NULL DEFAULT 0,
    final_risk_score INT NOT NULL DEFAULT 0,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
    recommended_action VARCHAR(80) NOT NULL DEFAULT 'Allow',
    risk_score INT NOT NULL DEFAULT 0,
    risk_band ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(company_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE transaction_screening_matches (
    screening_match_id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    watchlist_id VARCHAR(30) NOT NULL,
    watchlist_name VARCHAR(120) NOT NULL,
    match_type VARCHAR(50) NOT NULL,
    match_field VARCHAR(50) NOT NULL,
    input_value VARCHAR(255) NULL,
    match_country VARCHAR(80) NULL,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL,
    match_score INT NOT NULL,
    reason VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    UNIQUE KEY uniq_transaction_screening_match (transaction_id, watchlist_id, match_field)
);

CREATE TABLE transaction_matched_rules (
    matched_rule_id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    rule_id VARCHAR(30) NOT NULL,
    rule_weight INT NOT NULL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES compliance_rules(rule_id),
    UNIQUE KEY uniq_transaction_rule (transaction_id, rule_id)
);

CREATE TABLE alerts (
    alert_id VARCHAR(40) PRIMARY KEY,
    transaction_id VARCHAR(40) NOT NULL,
    primary_rule_id VARCHAR(30) NULL,
    grouped_count INT NOT NULL DEFAULT 1,
    company_id VARCHAR(20) NOT NULL,
    customer_id VARCHAR(30) NOT NULL,
    severity ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL,
    risk_score INT NOT NULL,
    mcc_risk_score INT NOT NULL DEFAULT 0,
    profile_risk_score INT NOT NULL DEFAULT 0,
    transaction_detection_score INT NOT NULL DEFAULT 0,
    final_risk_score INT NOT NULL DEFAULT 0,
    risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
    recommended_action VARCHAR(80) NOT NULL DEFAULT 'Allow',
    alert_status ENUM('New', 'Under Review', 'Escalated', 'Resolved', 'False Positive') NOT NULL DEFAULT 'New',
    analyst VARCHAR(100) NOT NULL DEFAULT 'Unassigned',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    FOREIGN KEY (primary_rule_id) REFERENCES compliance_rules(rule_id),
    FOREIGN KEY (company_id) REFERENCES companies(company_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE alert_transaction_links (
    alert_id VARCHAR(40) NOT NULL,
    transaction_id VARCHAR(40) NOT NULL,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (alert_id, transaction_id),
    FOREIGN KEY (alert_id) REFERENCES alerts(alert_id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE
);

CREATE TABLE compliance_cases (
    case_id VARCHAR(40) PRIMARY KEY,
    alert_id VARCHAR(40) NOT NULL,
    company_id VARCHAR(20) NOT NULL,
    customer_id VARCHAR(30) NOT NULL,
    summary VARCHAR(255) NOT NULL,
    priority ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL,
    case_status ENUM('New', 'Under Review', 'Escalated', 'Resolved', 'False Positive') NOT NULL DEFAULT 'New',
    owner VARCHAR(100) NOT NULL DEFAULT 'Operations Team',
    due_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    FOREIGN KEY (alert_id) REFERENCES alerts(alert_id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(company_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE audit_logs (
    audit_id VARCHAR(40) PRIMARY KEY,
    action VARCHAR(120) NOT NULL,
    actor VARCHAR(100) NOT NULL DEFAULT 'System',
    entity_type VARCHAR(80) NOT NULL,
    entity_id VARCHAR(40),
    company_id VARCHAR(20),
    message VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(company_id)
);

-- Example merchant profiles only. Any Singapore merchant, regardless of industry, can be
-- onboarded the same way with its own MCC code, industry_risk_score, and merchant_risk_level.
INSERT INTO companies (company_id, company_name, merchant_type, mcc_code, industry, industry_risk_score, merchant_risk_level, accent)
VALUES
    ('companyA', 'Merchant Profile 5651', 'MCC 5651 - Family Clothing Stores', '5651', 'Family Clothing Stores', 8, 'LOW', 'blue'),
    ('companyB', 'Merchant Profile 5661', 'MCC 5661 - Shoe Stores', '5661', 'Shoe Stores', 12, 'MEDIUM', 'green'),
    ('companyC', 'Merchant Profile 5977', 'MCC 5977 - Cosmetic Stores', '5977', 'Cosmetic Stores', 10, 'HIGH', 'purple');

INSERT INTO customers (customer_id, customer_name, segment, kyc_status, customer_risk_level)
VALUES
    ('CUS-1001', 'Ava Lim', 'Retail', 'Verified', 'LOW'),
    ('CUS-1002', 'Noah Tan', 'SME', 'Verified', 'MEDIUM'),
    ('CUS-1003', 'Maya Wong', 'Private Client', 'Enhanced Due Diligence', 'HIGH'),
    ('CUS-1004', 'Ethan Koh', 'Retail', 'Pending Review', 'HIGH'),
    ('CUS-1005', 'Sophia Chen', 'Corporate', 'Verified', 'LOW');

INSERT INTO compliance_rules
    (rule_id, company_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type)
VALUES
    ('COM-A-001', 'companyA', 'Single transaction above S$700', 'Medium', 'Above this merchant profile''s typical basket size', 30, 700.00, NULL, 'amount'),
    ('COM-A-002', 'companyA', 'Single transaction above S$1,200', 'High', 'Far above this merchant profile''s typical basket size', 55, 1200.00, NULL, 'amount'),
    ('COM-A-003', 'companyA', '4+ merchant transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 4, 'recent_company_transactions'),
    ('COM-A-004', 'companyA', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant profile', 55, 1500.00, NULL, 'card_spend_24h'),
    ('COM-A-005', 'companyA', 'Several amounts just below S$700', 'Medium', 'Possible threshold avoidance', 30, 700.00, 3, 'near_threshold'),
    ('COM-A-006', 'companyA', 'New or usually low-spend customer above S$800', 'Medium', 'New card/account, or a sudden spend jump, plus a high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer'),
    ('COM-B-001', 'companyB', 'Single transaction above S$1,000', 'Medium', 'Above this merchant profile''s typical basket size', 30, 1000.00, NULL, 'amount'),
    ('COM-B-002', 'companyB', 'Single transaction above S$2,000', 'High', 'Far above this merchant profile''s typical basket size', 55, 2000.00, NULL, 'amount'),
    ('COM-B-003', 'companyB', '3+ merchant transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 3, 'recent_company_transactions'),
    ('COM-B-004', 'companyB', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant profile', 55, 1500.00, NULL, 'card_spend_24h'),
    ('COM-B-005', 'companyB', 'Several amounts just below S$1,000', 'Medium', 'Possible threshold avoidance', 30, 1000.00, 3, 'near_threshold'),
    ('COM-B-006', 'companyB', 'New or usually low-spend customer above S$800', 'Medium', 'New card/account, or a sudden spend jump, plus a high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer'),
    ('COM-C-001', 'companyC', 'Single transaction above S$700', 'Medium', 'Above this merchant profile''s typical basket size', 30, 700.00, NULL, 'amount'),
    ('COM-C-002', 'companyC', 'Single transaction above S$1,000', 'High', 'Far above this merchant profile''s typical basket size', 55, 1000.00, NULL, 'amount'),
    ('COM-C-003', 'companyC', '4+ merchant transactions within 30 min', 'Medium', 'Possible split payment or repeated card attempts', 30, NULL, 4, 'recent_company_transactions'),
    ('COM-C-004', 'companyC', 'Same card spends above S$1,500 within 24h', 'High', 'Unusual cumulative same-card spend for this merchant profile', 55, 1500.00, NULL, 'card_spend_24h'),
    ('COM-C-005', 'companyC', 'Several amounts just below S$700', 'Medium', 'Possible threshold avoidance', 30, 700.00, 3, 'near_threshold'),
    ('COM-C-006', 'companyC', 'New or usually low-spend customer above S$800', 'Medium', 'New card/account, or a sudden spend jump, plus a high-value purchase', 35, 800.00, NULL, 'new_or_deviating_customer'),
    ('TIME-001', 'companyA', 'Transaction Outside Operating Hours', 'Medium', 'Transaction occurred outside normal merchant operating hours.', 10, NULL, NULL, 'operating_hours'),
    ('SCR-001', 'companyA', 'Payment or customer screening match', 'High', 'Sanctions, PEP, watchlist, or adverse-media screening match', 65, NULL, NULL, 'screening_match'),
    ('PROFILE-CUSTOMER-HIGH', 'companyA', 'High-risk customer profile', 'High', 'Customer KYC risk level is HIGH', 30, NULL, NULL, 'profile_risk'),
    ('PROFILE-MERCHANT-HIGH', 'companyA', 'High-risk merchant profile', 'High', 'Merchant risk level is HIGH', 30, NULL, NULL, 'profile_risk'),
    ('RULE-001', 'companyA', 'Large local card transaction', 'High', 'Local card transaction equal to or above SGD 10,000.', 35, 10000.00, NULL, 'amount'),
    ('RULE-002', 'companyA', 'Contextual jurisdiction escalation', 'High', 'Customer, issuer, or counterparty data references a high-risk jurisdiction.', 20, NULL, NULL, 'jurisdiction'),
    ('RULE-003', 'companyA', 'Elevated same-card spend', 'Medium', 'Unusual cumulative spend on the same card within 24 hours.', 35, 3000.00, NULL, 'card_spend_24h'),
    ('RULE-004', 'companyA', 'Incomplete customer diligence', 'Medium', 'Customer KYC profile is pending review.', 25, NULL, NULL, 'kyc_pending'),
    ('RULE-005', 'companyA', 'Low-value card testing burst', 'High', 'Repeated low-value card payments may indicate card testing.', 30, 20.00, 5, 'low_value_burst');

INSERT INTO transactions
    (transaction_id, company_id, customer_id, amount, currency, country, merchant_category,
     recent_company_transactions, card_spend_24h, near_threshold_count, low_value_burst_count,
     is_new_customer, usual_spend_below_100, channel, direction, counterparty_name,
     counterparty_country, payment_reference, screening_status, status, transaction_hour,
     operating_hours_triggered, mcc_risk_score,
     profile_risk_score, transaction_detection_score, final_risk_score, risk_level,
     recommended_action, risk_score, risk_band, created_at)
VALUES
    ('TXN-DEMO-001', 'companyA', 'CUS-1001', 95.00, 'SGD', 'Singapore', 'Apparel', 1, 180.00, 0, 0, 0, 0, 'Card Present', 'Sale', 'Harbour Retail Pte Ltd', 'Singapore', 'Local card purchase Harbour Retail Pte Ltd', 'Clear', 'Cleared', 14, 0, 8, 0, 0, 8, 'Low', 'Allow', 8, 'Low', '2026-06-03 14:00:00'),
    ('TXN-DEMO-002', 'companyB', 'CUS-1003', 2150.00, 'SGD', 'Singapore', 'Footwear', 1, 2300.00, 0, 0, 0, 0, 'E-Commerce Card', 'Sale', 'Orion Trade Holdings', 'Iran', 'Card payment linked to Orion Trade Holdings', 'Potential Match', 'Flagged', 2, 1, 12, 45, 220, 277, 'Critical', 'Manual Review or Hold Settlement', 277, 'Critical', '2026-06-03 02:00:00'),
    ('TXN-DEMO-003', 'companyC', 'CUS-1004', 880.00, 'SGD', 'Singapore', 'Cosmetics', 4, 950.00, 1, 0, 1, 0, 'Card Not Present', 'Sale', 'Maple Distribution', 'Singapore', 'Local card purchase Maple Distribution', 'Clear', 'Flagged', 14, 0, 10, 60, 95, 165, 'Critical', 'Manual Review or Hold Settlement', 165, 'Critical', '2026-06-03 14:00:00');

INSERT INTO transaction_screening_matches
    (transaction_id, watchlist_id, watchlist_name, match_type, match_field, input_value,
     match_country, risk_level, match_score, reason)
VALUES
    ('TXN-DEMO-002', 'WL-SAN-001', 'Orion Trade Holdings', 'Sanctions', 'Context Party',
     'Orion Trade Holdings', 'Iran', 'Critical', 100, 'Sanctions list match for contextual payment party'),
    ('TXN-DEMO-002', 'WL-SAN-001', 'Orion Trade Holdings', 'Sanctions', 'Payment Details',
     'Card payment linked to Orion Trade Holdings', 'Iran', 'Critical', 88, 'Sanctions list match for contextual payment party');

INSERT INTO transaction_matched_rules (transaction_id, rule_id, rule_weight)
VALUES
    ('TXN-DEMO-002', 'COM-B-001', 30),
    ('TXN-DEMO-002', 'COM-B-002', 60),
    ('TXN-DEMO-002', 'COM-B-004', 55),
    ('TXN-DEMO-002', 'TIME-001', 10),
    ('TXN-DEMO-002', 'SCR-001', 65),
    ('TXN-DEMO-002', 'PROFILE-CUSTOMER-HIGH', 30),
    ('TXN-DEMO-003', 'COM-C-001', 30),
    ('TXN-DEMO-003', 'COM-C-003', 30),
    ('TXN-DEMO-003', 'COM-C-006', 35),
    ('TXN-DEMO-003', 'PROFILE-CUSTOMER-HIGH', 30),
    ('TXN-DEMO-003', 'PROFILE-MERCHANT-HIGH', 30);

INSERT INTO alerts
    (alert_id, transaction_id, primary_rule_id, grouped_count, company_id, customer_id, severity, risk_score, mcc_risk_score, profile_risk_score, transaction_detection_score, final_risk_score, risk_level, recommended_action, alert_status, analyst)
VALUES
    ('ALT-DEMO-001', 'TXN-DEMO-002', 'COM-B-001', 1, 'companyB', 'CUS-1003', 'Critical', 277, 12, 45, 220, 277, 'Critical', 'Manual Review or Hold Settlement', 'New', 'Unassigned'),
    ('ALT-DEMO-002', 'TXN-DEMO-003', 'COM-C-001', 1, 'companyC', 'CUS-1004', 'Critical', 165, 10, 60, 95, 165, 'Critical', 'Manual Review or Hold Settlement', 'Under Review', 'Operations Team');

INSERT INTO alert_transaction_links (alert_id, transaction_id)
VALUES
    ('ALT-DEMO-001', 'TXN-DEMO-002'),
    ('ALT-DEMO-002', 'TXN-DEMO-003');

INSERT INTO compliance_cases
    (case_id, alert_id, company_id, customer_id, summary, priority, case_status, owner, due_at)
VALUES
    ('CASE-DEMO-001', 'ALT-DEMO-001', 'companyB', 'CUS-1003', 'SGD 2,150 sale card transaction flagged', 'Critical', 'New', 'Operations Team', DATE_ADD(NOW(), INTERVAL 2 DAY)),
    ('CASE-DEMO-002', 'ALT-DEMO-002', 'companyC', 'CUS-1004', 'SGD 880 sale card transaction flagged', 'Critical', 'Under Review', 'Operations Team', DATE_ADD(NOW(), INTERVAL 2 DAY));

INSERT INTO audit_logs
    (audit_id, action, actor, entity_type, entity_id, company_id, message)
VALUES
    ('AUD-DEMO-001', 'Alert Created', 'System', 'Alert', 'ALT-DEMO-001', 'companyB', 'Critical alert opened for Merchant Profile 5661 transaction'),
    ('AUD-DEMO-002', 'Case Created', 'System', 'Case', 'CASE-DEMO-001', 'companyB', 'Case generated from alert ALT-DEMO-001'),
    ('AUD-DEMO-003', 'Alert Status Changed', 'Operations Team', 'Alert', 'ALT-DEMO-002', 'companyC', 'ALT-DEMO-002 moved from New to Under Review');

CREATE INDEX idx_transactions_company ON transactions(company_id);
CREATE INDEX idx_transactions_customer ON transactions(customer_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_risk_band ON transactions(risk_band);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_screening_matches_transaction ON transaction_screening_matches(transaction_id);
CREATE INDEX idx_alerts_status ON alerts(alert_status);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_grouping ON alerts(customer_id, company_id, primary_rule_id, alert_status);
CREATE INDEX idx_cases_status ON compliance_cases(case_status);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

DELIMITER $$

CREATE TRIGGER update_transaction_risk_after_rule_insert
AFTER INSERT ON transaction_matched_rules
FOR EACH ROW
BEGIN
    DECLARE v_mcc_risk_score INT DEFAULT 0;
    DECLARE v_profile_risk_score INT DEFAULT 0;
    DECLARE v_transaction_detection_score INT DEFAULT 0;
    DECLARE v_final_risk_score INT DEFAULT 0;

    SELECT COALESCE(c.industry_risk_score, 0),
           CASE cu.customer_risk_level WHEN 'HIGH' THEN 30 WHEN 'MEDIUM' THEN 15 ELSE 0 END
           + CASE c.merchant_risk_level WHEN 'HIGH' THEN 30 WHEN 'MEDIUM' THEN 15 ELSE 0 END
    INTO v_mcc_risk_score, v_profile_risk_score
    FROM transactions t
    JOIN companies c ON t.company_id = c.company_id
    JOIN customers cu ON t.customer_id = cu.customer_id
    WHERE t.transaction_id = NEW.transaction_id;

    SELECT COALESCE(SUM(rule_weight), 0)
    INTO v_transaction_detection_score
    FROM transaction_matched_rules
    WHERE transaction_id = NEW.transaction_id
      AND rule_id NOT LIKE 'PROFILE-%';

    SET v_final_risk_score = v_mcc_risk_score + v_profile_risk_score + v_transaction_detection_score;

    UPDATE transactions t
    SET mcc_risk_score = v_mcc_risk_score,
        profile_risk_score = v_profile_risk_score,
        transaction_detection_score = v_transaction_detection_score,
        transaction_hour = HOUR(t.created_at),
        operating_hours_triggered = CASE WHEN HOUR(t.created_at) < 7 OR HOUR(t.created_at) >= 23 THEN 1 ELSE 0 END,
        final_risk_score = v_final_risk_score,
        risk_score = v_final_risk_score,
        risk_level = CASE
            WHEN v_final_risk_score >= 70 THEN 'Critical'
            WHEN v_final_risk_score >= 50 THEN 'High'
            WHEN v_final_risk_score >= 30 THEN 'Medium'
            ELSE 'Low'
        END,
        risk_band = CASE
            WHEN v_final_risk_score >= 70 THEN 'Critical'
            WHEN v_final_risk_score >= 50 THEN 'High'
            WHEN v_final_risk_score >= 30 THEN 'Medium'
            ELSE 'Low'
        END,
        recommended_action = CASE
            WHEN v_final_risk_score >= 70 THEN 'Manual Review or Hold Settlement'
            WHEN v_final_risk_score >= 50 THEN 'Request OTP'
            WHEN v_final_risk_score >= 30 THEN 'Monitor'
            ELSE 'Allow'
        END,
        status = 'Flagged'
    WHERE t.transaction_id = NEW.transaction_id;
END$$

CREATE PROCEDURE open_alert_for_transaction(IN p_transaction_id VARCHAR(40))
BEGIN
    DECLARE v_alert_id VARCHAR(40);
    DECLARE v_company_id VARCHAR(20);
    DECLARE v_customer_id VARCHAR(30);
    DECLARE v_primary_rule_id VARCHAR(30);
    DECLARE v_risk_score INT;
    DECLARE v_risk_band VARCHAR(20);
    DECLARE v_mcc_risk_score INT;
    DECLARE v_profile_risk_score INT;
    DECLARE v_transaction_detection_score INT;
    DECLARE v_recommended_action VARCHAR(80);

    SET v_alert_id = CONCAT('ALT-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 10000));

    SELECT company_id, customer_id, final_risk_score, risk_level, mcc_risk_score,
           profile_risk_score, transaction_detection_score, recommended_action
    INTO v_company_id, v_customer_id, v_risk_score, v_risk_band, v_mcc_risk_score,
         v_profile_risk_score, v_transaction_detection_score, v_recommended_action
    FROM transactions
    WHERE transaction_id = p_transaction_id;

    SELECT rule_id
    INTO v_primary_rule_id
    FROM transaction_matched_rules
    WHERE transaction_id = p_transaction_id
    ORDER BY rule_weight DESC, matched_rule_id ASC
    LIMIT 1;

    INSERT INTO alerts
        (alert_id, transaction_id, primary_rule_id, grouped_count, company_id, customer_id,
         severity, risk_score, mcc_risk_score, profile_risk_score, transaction_detection_score,
         final_risk_score, risk_level, recommended_action)
    VALUES
        (v_alert_id, p_transaction_id, v_primary_rule_id, 1, v_company_id, v_customer_id,
         v_risk_band, v_risk_score, v_mcc_risk_score, v_profile_risk_score,
         v_transaction_detection_score, v_risk_score, v_risk_band, v_recommended_action);

    INSERT INTO alert_transaction_links (alert_id, transaction_id)
    VALUES (v_alert_id, p_transaction_id);
END$$

CREATE PROCEDURE create_case_for_alert(IN p_alert_id VARCHAR(40))
BEGIN
    DECLARE v_company_id VARCHAR(20);
    DECLARE v_customer_id VARCHAR(30);
    DECLARE v_severity VARCHAR(20);
    DECLARE v_transaction_id VARCHAR(40);
    DECLARE v_amount DECIMAL(10,2);
    DECLARE v_direction VARCHAR(20);

    SELECT a.company_id, a.customer_id, a.severity, a.transaction_id, t.amount, t.direction
    INTO v_company_id, v_customer_id, v_severity, v_transaction_id, v_amount, v_direction
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.transaction_id
    WHERE a.alert_id = p_alert_id;

    INSERT INTO compliance_cases
        (case_id, alert_id, company_id, customer_id, summary, priority, due_at)
    VALUES
        (CONCAT('CASE-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 10000)),
         p_alert_id,
         v_company_id,
         v_customer_id,
         CONCAT('SGD ', v_amount, ' ', LOWER(v_direction), ' transaction flagged'),
         v_severity,
         DATE_ADD(NOW(), INTERVAL 2 DAY));
END$$

DELIMITER ;
