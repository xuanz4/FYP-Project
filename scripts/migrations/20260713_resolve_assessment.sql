USE fyp_transaction_monitoring;

-- Store assessment outcome fields on the case, while final risk score/level stay on the transaction.
ALTER TABLE compliance_cases
  ADD COLUMN IF NOT EXISTS decision ENUM('Accepted', 'Rejected', 'Escalated') NULL AFTER owner,
  ADD COLUMN IF NOT EXISTS resolution_reason VARCHAR(80) NULL AFTER decision,
  ADD COLUMN IF NOT EXISTS analyst_notes TEXT NULL AFTER resolution_reason,
  ADD COLUMN IF NOT EXISTS resolved_at DATETIME NULL AFTER analyst_notes;

ALTER TABLE transactions
  MODIFY final_risk_score INT NULL,
  MODIFY final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL;
