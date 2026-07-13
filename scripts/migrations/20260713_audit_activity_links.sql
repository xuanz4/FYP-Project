USE fyp_transaction_monitoring;

-- Extend the existing global audit table so the same rows can power
-- transaction-specific activity timelines. Existing rows are preserved.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(40) NULL AFTER entity_id,
  ADD COLUMN IF NOT EXISTS alert_id VARCHAR(40) NULL AFTER transaction_id,
  ADD COLUMN IF NOT EXISTS case_id VARCHAR(40) NULL AFTER alert_id;

CREATE INDEX idx_audit_logs_transaction ON audit_logs(transaction_id);
CREATE INDEX idx_audit_logs_alert ON audit_logs(alert_id);
CREATE INDEX idx_audit_logs_case ON audit_logs(case_id);

-- RFI is an open assessment state, so cases need a durable status for it.
ALTER TABLE compliance_cases
  MODIFY case_status ENUM('New', 'Under Review', 'Waiting for Information', 'Escalated', 'Resolved', 'False Positive') NOT NULL DEFAULT 'New';
