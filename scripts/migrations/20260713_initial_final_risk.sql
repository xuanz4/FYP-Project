USE fyp_transaction_monitoring;

-- Existing production/demo rows currently store the automated score in final_risk_score.
-- This migration preserves that value by copying it to the new initial-risk columns.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS initial_risk_score INT NOT NULL DEFAULT 0 AFTER transaction_detection_score,
  ADD COLUMN IF NOT EXISTS initial_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low' AFTER initial_risk_score,
  ADD COLUMN IF NOT EXISTS final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL AFTER final_risk_score;

UPDATE transactions
SET initial_risk_score = COALESCE(NULLIF(initial_risk_score, 0), final_risk_score, risk_score, 0),
    initial_risk_level = COALESCE(initial_risk_level, risk_level, risk_band, 'Low');

ALTER TABLE transactions
  MODIFY final_risk_score INT NULL,
  MODIFY final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL;

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS initial_risk_score INT NOT NULL DEFAULT 0 AFTER transaction_detection_score,
  ADD COLUMN IF NOT EXISTS initial_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low' AFTER initial_risk_score,
  ADD COLUMN IF NOT EXISTS final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL AFTER final_risk_score;

UPDATE alerts
SET initial_risk_score = COALESCE(NULLIF(initial_risk_score, 0), final_risk_score, risk_score, 0),
    initial_risk_level = COALESCE(initial_risk_level, risk_level, severity, 'Low');

ALTER TABLE alerts
  MODIFY final_risk_score INT NULL,
  MODIFY final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL;
