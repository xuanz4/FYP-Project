const assessmentDecisions = ['Accepted', 'Rejected'];
const resolutionReasons = ['Legitimate Transaction', 'False Positive', 'Suspicious Activity', 'Insufficient Information', 'Other'];
const stroReferralReasons = [
  'Possible suspicious activity',
  'Strong screening evidence',
  'Unexplained transaction behaviour',
  'RFI response remains insufficient',
  'Other',
];
const escalationDestinations = ['Senior Analyst', 'STRO'];
const escalationReasons = [
  'Critical risk requires senior review',
  'Possible suspicious activity / STR consideration',
  'Strong screening evidence',
  'RFI response remains insufficient',
  'Complex transaction behaviour',
  'Other',
];
const strEvidenceOptions = [
  'Triggered monitoring rules',
  'Screening evidence',
  'Screening matches',
  'Customer profile risk',
  'Merchant profile risk',
  'Transaction behaviour',
  'RFI response',
  'Other',
];

// Rule types (see compliance_rules.rule_type) grouped by which STR evidence checkbox they support.
const strEvidenceRuleTypeGroups = {
  'Customer profile risk': ['new_or_deviating_customer', 'kyc_pending'],
  'Transaction behaviour': ['amount', 'recent_merchant_transactions', 'card_spend_24h', 'near_threshold', 'operating_hours', 'low_value_burst'],
  'Screening matches': ['jurisdiction'],
};

const emptyStrAutoFill = {
  referenceNumber: '',
  filingDate: '',
  reportingReason: '',
  suspicionSummary: '',
  stroNotes: '',
  supportingEvidence: [],
};

const seniorAuditDefaultActions = [
  'Case Escalated to Senior Analyst',
  'Case Assigned',
  'Request for Information Sent',
  'Case Referred to STRO',
  'STR Recommended',
  'Final Risk Assigned',
  'Assessment Resolved',
  'Additional Information Requested by STRO',
];

const stroAuditDefaultActions = [
  'Case Referred to STRO',
  'STR Recommended',
  'STR Submitted for Approval',
  'STR Filed',
  'STR Marked Not Required',
  'Additional Information Requested by STRO',
];

const STALE_CASE_MINUTES = 15;

module.exports = {
  assessmentDecisions,
  resolutionReasons,
  stroReferralReasons,
  escalationDestinations,
  escalationReasons,
  strEvidenceOptions,
  strEvidenceRuleTypeGroups,
  emptyStrAutoFill,
  seniorAuditDefaultActions,
  stroAuditDefaultActions,
  STALE_CASE_MINUTES,
};
