const database = require('../database');
const { id } = require('./ids');

function memoizeAsync(fn) {
  let inFlight = null;
  return (...args) => {
    if (!inFlight) {
      inFlight = fn(...args).catch((error) => {
        inFlight = null;
        throw error;
      });
    }
    return inFlight;
  };
}

const ensureDatabaseResolveColumns = memoizeAsync(async function ensureDatabaseResolveColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN ('transactions', 'cases')
       AND COLUMN_NAME IN ('final_risk_score', 'final_risk_level', 'decision', 'resolution_reason', 'analyst_notes', 'resolved_at', 'resolved_by')`,
    [dbName],
  );
  const hasColumn = (table, column) => columns.some((row) => row.TABLE_NAME === table && row.COLUMN_NAME === column);

  if (!hasColumn('transactions', 'final_risk_score')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN final_risk_score INT NULL AFTER risk_level');
  }
  if (!hasColumn('transactions', 'final_risk_level')) {
    await database.execute("ALTER TABLE transactions ADD COLUMN final_risk_level ENUM('Low', 'Medium', 'High', 'Critical') NULL AFTER final_risk_score");
  }
  if (!hasColumn('cases', 'decision')) {
    await database.execute('ALTER TABLE cases ADD COLUMN decision VARCHAR(40) NULL AFTER notes');
  }
  if (!hasColumn('cases', 'resolution_reason')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolution_reason VARCHAR(120) NULL AFTER decision');
  }
  if (!hasColumn('cases', 'analyst_notes')) {
    await database.execute('ALTER TABLE cases ADD COLUMN analyst_notes TEXT NULL AFTER resolution_reason');
  }
  if (!hasColumn('cases', 'resolved_at')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolved_at DATETIME NULL AFTER analyst_notes');
  }
  if (!hasColumn('cases', 'resolved_by')) {
    await database.execute('ALTER TABLE cases ADD COLUMN resolved_by VARCHAR(40) NULL AFTER resolved_at');
  }

  const [caseStatusColumn] = await database.query(
    `SELECT COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases' AND COLUMN_NAME = 'status'
     LIMIT 1`,
    [dbName],
  );
  if (caseStatusColumn[0] && !caseStatusColumn[0].COLUMN_TYPE.includes("'Resolved'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }

  const [actionStatusColumn] = await database.query(
    `SELECT COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'action_status'
     LIMIT 1`,
    [dbName],
  );
  if (actionStatusColumn[0] && !actionStatusColumn[0].COLUMN_TYPE.includes("'Resolved'")) {
    await database.execute("ALTER TABLE transactions MODIFY action_status ENUM('None', 'Pending RFI', 'Pending Senior Review', 'STR Filed', 'Dismissed as False Positive', 'Escalated', 'Resolved') NOT NULL DEFAULT 'None'");
  }
});

const ensureCaseAssignmentColumns = memoizeAsync(async function ensureCaseAssignmentColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [tables] = await database.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
     LIMIT 1`,
    [dbName],
  );
  if (!tables[0]) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('due_at', 'status', 'last_actioned_by', 'last_actioned_at')`,
    [dbName],
  );
  const dueColumn = columns.find((row) => row.COLUMN_NAME === 'due_at');
  const statusColumn = columns.find((row) => row.COLUMN_NAME === 'status');
  const hasCaseColumn = (column) => columns.some((row) => row.COLUMN_NAME === column);

  if (!dueColumn) {
    await database.execute('ALTER TABLE cases ADD COLUMN due_at DATETIME NULL AFTER notes');
  }

  if (statusColumn && !statusColumn.COLUMN_TYPE.includes("'Under Review'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }

  // Tracks whichever analyst/senior analyst/STRO most recently took ANY action on the case
  // (assign, RFI, escalate, refer to STRO, STR file, resolve) - distinct from
  // referred_to_stro_by, which only ever reflects the literal STRO referral. Powers the
  // "Referred By" display on the transaction detail page so it updates after every action
  // instead of staying "Not assigned" until a case is specifically routed to STRO.
  if (!hasCaseColumn('last_actioned_by')) {
    await database.execute('ALTER TABLE cases ADD COLUMN last_actioned_by VARCHAR(20) NULL AFTER assigned_to');
  }
  if (!hasCaseColumn('last_actioned_at')) {
    await database.execute('ALTER TABLE cases ADD COLUMN last_actioned_at DATETIME NULL AFTER last_actioned_by');
  }
});

const ensureStrWorkflowSchema = memoizeAsync(async function ensureStrWorkflowSchema() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  await ensureCaseAssignmentColumns();

  const [caseColumns] = await database.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('assigned_role', 'escalation_destination', 'referred_to_stro_at', 'referred_to_stro_by', 'status')`,
    [dbName],
  );
  const hasCaseColumn = (column) => caseColumns.some((row) => row.COLUMN_NAME === column);
  const statusColumn = caseColumns.find((row) => row.COLUMN_NAME === 'status');

  if (!hasCaseColumn('assigned_role')) {
    await database.execute('ALTER TABLE cases ADD COLUMN assigned_role VARCHAR(40) NULL AFTER assigned_to');
  }
  if (!hasCaseColumn('escalation_destination')) {
    await database.execute('ALTER TABLE cases ADD COLUMN escalation_destination VARCHAR(40) NULL AFTER assigned_role');
  }
  if (!hasCaseColumn('referred_to_stro_at')) {
    await database.execute('ALTER TABLE cases ADD COLUMN referred_to_stro_at DATETIME NULL AFTER due_at');
  }
  if (!hasCaseColumn('referred_to_stro_by')) {
    await database.execute('ALTER TABLE cases ADD COLUMN referred_to_stro_by VARCHAR(20) NULL AFTER referred_to_stro_at');
  }
  if (statusColumn && !statusColumn.COLUMN_TYPE.includes("'STR Filed'")) {
    await database.execute("ALTER TABLE cases MODIFY status ENUM('Open', 'Under Review', 'Pending RFI', 'Pending Senior Review', 'Escalated', 'Dismissed as False Positive', 'STR Filed', 'Resolved') NOT NULL DEFAULT 'Open'");
  }

  await database.execute(
    `CREATE TABLE IF NOT EXISTS str_reports (
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
      INDEX idx_str_transaction (transaction_id),
      INDEX idx_str_status (str_status)
    )`,
  );
});

// Real additive risk formula (MCC + Profile + Detection) needs each component persisted per
// transaction, plus a stable human-facing reference number - see riskEngine.js/transactionIngestion.js.
const ensureRiskContributionColumns = memoizeAsync(async function ensureRiskContributionColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions'
       AND COLUMN_NAME IN ('mcc_risk_contribution', 'profile_risk_contribution', 'transaction_detection_contribution', 'unique_transaction_reference')`,
    [dbName],
  );
  const hasColumn = (column) => columns.some((row) => row.COLUMN_NAME === column);

  if (!hasColumn('mcc_risk_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN mcc_risk_contribution INT NULL AFTER risk_level');
  }
  if (!hasColumn('profile_risk_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN profile_risk_contribution INT NULL AFTER mcc_risk_contribution');
  }
  if (!hasColumn('transaction_detection_contribution')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN transaction_detection_contribution INT NULL AFTER profile_risk_contribution');
  }
  if (!hasColumn('unique_transaction_reference')) {
    await database.execute('ALTER TABLE transactions ADD COLUMN unique_transaction_reference VARCHAR(50) NULL AFTER transaction_id');
  }

  // Older UNIWEB test rows have a risk_score/risk_level but no persisted component breakdown.
  // Reconstruct a bounded breakdown without changing the original score: merchant MCC first,
  // matched-rule weights second, and any remaining historical points as Profile contribution.
  // New transactions already persist all three components and are not touched.
  await database.execute(
    `UPDATE transactions t
     LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     LEFT JOIN (
       SELECT tmr.transaction_id, SUM(COALESCE(cr.weight, 0)) AS rule_points
       FROM transaction_matched_rules tmr
       LEFT JOIN compliance_rules cr ON cr.rule_id = tmr.rule_id
       GROUP BY tmr.transaction_id
     ) matched ON matched.transaction_id = t.transaction_id
     SET
       t.mcc_risk_contribution =
         LEAST(t.risk_score, GREATEST(0, COALESCE(m.mcc_risk_score, 0))),
       t.transaction_detection_contribution =
         LEAST(
           GREATEST(t.risk_score - LEAST(t.risk_score, GREATEST(0, COALESCE(m.mcc_risk_score, 0))), 0),
           GREATEST(0, COALESCE(matched.rule_points, 0))
         ),
       t.profile_risk_contribution =
         GREATEST(
           t.risk_score
             - LEAST(t.risk_score, GREATEST(0, COALESCE(m.mcc_risk_score, 0)))
             - LEAST(
               GREATEST(t.risk_score - LEAST(t.risk_score, GREATEST(0, COALESCE(m.mcc_risk_score, 0))), 0),
               GREATEST(0, COALESCE(matched.rule_points, 0))
             ),
           0
         )
     WHERE t.risk_score > 0
       AND COALESCE(t.mcc_risk_contribution, 0) = 0
       AND COALESCE(t.profile_risk_contribution, 0) = 0
       AND COALESCE(t.transaction_detection_contribution, 0) = 0`,
  );

  const [indexes] = await database.query(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND INDEX_NAME = 'uniq_unique_transaction_reference'`,
    [dbName],
  );
  if (!indexes.length) {
    await database.execute('ALTER TABLE transactions ADD UNIQUE INDEX uniq_unique_transaction_reference (unique_transaction_reference)');
  }
});

// One row per merchant MID summarising that merchant's history, so "Profile Risk" is a real
// computed number instead of always showing "Not stored". Written by transactionIngestion.js
// right after each transaction is ingested; read by riskEngine.js for the next transaction's
// profileRiskContribution.
const ensureMerchantRiskProfileTable = memoizeAsync(async function ensureMerchantRiskProfileTable() {
  if (!database.isEnabled()) return;
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_risk_profiles (
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
    )`,
  );
});

// Auditable merchant contact record, replacing the single mutable merchants.authorised_contact_*
// columns. Always queried live (never cached) by the RFI workflow and the transaction detail
// page, so an Admin's edit here takes effect immediately with no other code change.
const ensureMerchantContactsTable = memoizeAsync(async function ensureMerchantContactsTable() {
  if (!database.isEnabled()) return;
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_contacts (
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
    )`,
  );

  // One-time backfill: merchants.authorised_contact_name/email is the legacy single mutable
  // field this table replaces. Admin edits now only ever touch merchant_contacts, so any
  // pre-existing legacy value needs to land here once, or it becomes invisible to the RFI
  // workflow and the transaction detail page (both read merchant_contacts exclusively) even
  // though it's still sitting on the merchants row. Only copies where no merchant_contacts row
  // exists yet, so it never clobbers a value someone has already entered the new way.
  await database.execute(
    `INSERT INTO merchant_contacts (contact_id, merchant_id, merchant_mid, contact_name, rfi_email, status, updated_at)
     SELECT CONCAT('MCT-BACKFILL-', m.merchant_id), m.merchant_id, m.merchant_mid, m.authorised_contact_name, m.authorised_contact_email, 'Active', NOW()
     FROM merchants m
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = m.merchant_id
     WHERE mc.merchant_id IS NULL
       AND (m.authorised_contact_name IS NOT NULL OR m.authorised_contact_email IS NOT NULL)`,
  );
});

// Optional manual reconciliation entered by the resolver, compared against the transaction's
// stored automated contributions/score to catch false positives or calculation errors.
const ensureCaseReconciliationColumns = memoizeAsync(async function ensureCaseReconciliationColumns() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [columns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cases'
       AND COLUMN_NAME IN ('manual_mcc_contribution', 'manual_profile_contribution', 'manual_detection_contribution', 'manual_final_score', 'discrepancy_flag', 'discrepancy_notes')`,
    [dbName],
  );
  const hasColumn = (column) => columns.some((row) => row.COLUMN_NAME === column);

  if (!hasColumn('manual_mcc_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_mcc_contribution INT NULL AFTER resolved_by');
  }
  if (!hasColumn('manual_profile_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_profile_contribution INT NULL AFTER manual_mcc_contribution');
  }
  if (!hasColumn('manual_detection_contribution')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_detection_contribution INT NULL AFTER manual_profile_contribution');
  }
  if (!hasColumn('manual_final_score')) {
    await database.execute('ALTER TABLE cases ADD COLUMN manual_final_score INT NULL AFTER manual_detection_contribution');
  }
  if (!hasColumn('discrepancy_flag')) {
    await database.execute('ALTER TABLE cases ADD COLUMN discrepancy_flag TINYINT(1) NULL AFTER manual_final_score');
  }
  if (!hasColumn('discrepancy_notes')) {
    await database.execute('ALTER TABLE cases ADD COLUMN discrepancy_notes TEXT NULL AFTER discrepancy_flag');
  }
});

// Merchant CDD/EDD due-diligence schema: self-declared/admin-entered baseline data (no live
// KYC/sanctions API - see src/lib/merchantCdd.js) that both feeds the risk engine (expected
// activity, EDD completion) and gates case resolution for high-risk merchants. Every write
// path stays auditable via the existing audit_logs pattern, called from adminController.js
// and transactionsController.js, not from here.
const ensureMerchantCddSchema = memoizeAsync(async function ensureMerchantCddSchema() {
  if (!database.isEnabled()) return;

  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_cdd_profiles (
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
    )`,
  );

  // Self-declared, not independently verified - no registry lookup exists in this project's
  // scope. id_reference/nationality are free-text exactly so the UI can label them as such.
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_beneficial_owners (
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
    )`,
  );

  // Manual attestation log, not a live sanctions/PEP/adverse-media API match - screened_against
  // is a free-text source note (e.g. "Manual check vs UN Consolidated List").
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_screening_records (
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
    )`,
  );

  // Supporting evidence files for the CDD baseline / EDD checklist / screening records - stored
  // on local disk under uploads/cdd/ (see src/middleware/upload.js), never under
  // /public, so a file is only reachable through the authenticated download route. document_type
  // mirrors the EDD checklist's field grouping so a document can be tied to the checklist item
  // it supports; 'Screening' and 'Other' cover screening-record backup and anything else.
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_cdd_documents (
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
    )`,
  );

  const dbName = process.env.DB_NAME;
  const [documentColumns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'merchant_cdd_documents'
       AND COLUMN_NAME IN ('transaction_id', 'case_id')`,
    [dbName],
  );
  const hasDocumentColumn = (column) => documentColumns.some((row) => row.COLUMN_NAME === column);
  if (!hasDocumentColumn('transaction_id')) {
    await database.execute(
      `ALTER TABLE merchant_cdd_documents
       ADD COLUMN transaction_id VARCHAR(40) NULL AFTER merchant_id,
       ADD INDEX idx_merchant_cdd_documents_transaction (transaction_id),
       ADD CONSTRAINT fk_merchant_cdd_documents_transaction
         FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE`,
    );
  }
  if (!hasDocumentColumn('case_id')) {
    await database.execute(
      `ALTER TABLE merchant_cdd_documents
       ADD COLUMN case_id VARCHAR(40) NULL AFTER transaction_id,
       ADD INDEX idx_merchant_cdd_documents_case (case_id),
       ADD CONSTRAINT fk_merchant_cdd_documents_case
         FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE`,
    );
  }

  // Split by who may set each field - see merchantCdd.js's eddComplete: the first three plus
  // senior_signoff_completed are all required, and senior_signoff_completed is only ever
  // written by a Senior Analyst/Admin write path, never by the Analyst-scoped endpoint - so no
  // single role can satisfy the resolve-gate on their own say-so.
  //
  // Keyed by transaction_id (one row per transaction's case), not merchant_id: an earlier
  // version keyed this table by merchant_id alone, which meant completing the checklist (or
  // uploading supporting evidence) against one transaction's case silently marked every other
  // transaction of the same merchant as complete too. If an install still has that old
  // merchant-keyed table, there is no sound way to backfill which transaction each row
  // belonged to, so it's dropped and rebuilt rather than migrated in place.
  const [existingEddColumns] = await database.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'merchant_edd_checklist' AND COLUMN_NAME = 'transaction_id'`,
    [dbName],
  );
  if (!existingEddColumns.length) {
    await database.execute('DROP TABLE IF EXISTS merchant_edd_checklist');
  }
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_edd_checklist (
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
    )`,
  );

  // CDD checklist: the baseline due-diligence steps every transaction's case must clear,
  // regardless of risk level (see merchantCdd.js's computeCddComplete). One row per transaction,
  // same shape and same reasoning as merchant_edd_checklist above - a transaction's own
  // checklist, never shared with sibling transactions of the same merchant. The two steps mirror
  // the Analyst-uploadable document types in transactionsController.js's DOCUMENT_TYPE_ROLE_MAP
  // ('Business Registration', 'Screening'): uploading the document is separate evidence, this
  // table is the analyst's explicit confirmation that it was checked.
  await database.execute(
    `CREATE TABLE IF NOT EXISTS merchant_cdd_checklist (
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
    )`,
  );
  // Keep historical rows consistent with the sign-off rule introduced in the case workspace.
  // A sign-off cannot remain valid when any prerequisite check is incomplete.
  await database.execute(
    `UPDATE merchant_edd_checklist
     SET senior_signoff_completed = 0,
         senior_signoff_notes = 'Automatically revoked because an EDD prerequisite is incomplete.',
         senior_signoff_at = NOW()
     WHERE senior_signoff_completed = 1
       AND (
         source_of_funds_verified = 0
         OR site_visit_completed = 0
         OR enhanced_verification_completed = 0
       )`,
  );

  // mailbox_reference anchors an 'RFI Reply Reviewed' entry to a real, independently
  // re-checkable email (Message-ID/date/from, or a body hash) found live in the mailbox at
  // submit time - see rfiEvidence.js. Other evidence_type values leave it NULL.
  await database.execute(
    `CREATE TABLE IF NOT EXISTS case_rfi_evidence (
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
    )`,
  );
  await database.execute(
    `ALTER TABLE merchant_cdd_documents
     MODIFY COLUMN document_type
       ENUM('Business Registration', 'Screening', 'Source of Funds', 'Site Visit', 'Enhanced Verification', 'Other') NOT NULL`,
  );

  // Records each mailbox reply once so repeated "Load Response" checks cannot create duplicate
  // receipt audit entries. The fingerprint uses Message-ID when available and a content hash
  // otherwise; the audit log separately records the later human review of that reply.
  await database.execute(
    `CREATE TABLE IF NOT EXISTS rfi_email_receipts (
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
    )`,
  );

  // Global rule so 'cdd_review_overdue' needs no special-casing in the additive score formula
  // (see riskEngine.js) - just another matched compliance_rules row, seeded once idempotently.
  const [existingRule] = await database.query(
    "SELECT rule_id FROM compliance_rules WHERE rule_type = 'cdd_review_overdue' AND merchant_id IS NULL LIMIT 1",
  );
  if (!existingRule.length) {
    await database.execute(
      `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
       VALUES (?, NULL, ?, 'Medium', ?, 15, NULL, NULL, 'cdd_review_overdue', 1)`,
      [id('RULE'), 'CDD Review Overdue', "Merchant's CDD/EDD review date has passed without a completed re-review"],
    );
  }
});

// Global rules so 'cvv_check_failed'/'expiry_check_failed' need no special-casing in the
// additive score formula (see riskEngine.js) - just other matched compliance_rules rows,
// seeded once idempotently, same pattern as 'cdd_review_overdue' above.
const ensureCardVerificationRules = memoizeAsync(async function ensureCardVerificationRules() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !database.isEnabled()) return;

  const [existingRules] = await database.query(
    "SELECT rule_type FROM compliance_rules WHERE rule_type IN ('cvv_check_failed', 'expiry_check_failed') AND merchant_id IS NULL",
  );
  const hasRule = (ruleType) => existingRules.some((row) => row.rule_type === ruleType);

  if (!hasRule('cvv_check_failed')) {
    await database.execute(
      `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
       VALUES (?, NULL, ?, 'Medium', ?, 20, NULL, NULL, 'cvv_check_failed', 1)`,
      [id('RULE'), 'CVV check failed', "The card's CVV did not match on authorisation"],
    );
  }
  if (!hasRule('expiry_check_failed')) {
    await database.execute(
      `INSERT INTO compliance_rules (rule_id, merchant_id, rule_name, risk_level, reason, weight, amount_threshold, count_threshold, rule_type, is_active)
       VALUES (?, NULL, ?, 'Medium', ?, 15, NULL, NULL, 'expiry_check_failed', 1)`,
      [id('RULE'), 'Card expiry check failed', "The card's expiry date did not match on authorisation"],
    );
  }
});

const ensureNotificationSchema = memoizeAsync(async function ensureNotificationSchema() {
  if (!database.isEnabled()) return;

  await database.execute(
    `CREATE TABLE IF NOT EXISTS rfi_requests (
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
    )`,
  );

  await database.execute(
    `CREATE TABLE IF NOT EXISTS notifications (
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
    )`,
  );
});

// Single call site for every ensure* above - covers the risk-formula, merchant-profile,
// merchant-contacts, case-reconciliation and merchant-CDD/EDD schema in one idempotent pass.
const ensureRiskAndContactSchema = memoizeAsync(async function ensureRiskAndContactSchema() {
  await ensureRiskContributionColumns();
  await ensureMerchantRiskProfileTable();
  await ensureMerchantContactsTable();
  await ensureCaseReconciliationColumns();
  await ensureMerchantCddSchema();
  await ensureCardVerificationRules();
  await ensureNotificationSchema();
});

module.exports = {
  ensureDatabaseResolveColumns,
  ensureCaseAssignmentColumns,
  ensureStrWorkflowSchema,
  ensureMerchantContactsTable,
  ensureMerchantCddSchema,
  ensureNotificationSchema,
  ensureRiskAndContactSchema,
};
