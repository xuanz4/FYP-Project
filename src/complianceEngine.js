const defaultRules = [
  {
    id: 'RULE-001',
    name: 'Large local card transaction',
    risk: 'High',
    reason: 'Local card transaction equal to or above SGD 10,000.',
    weight: 35,
    test: (txn) => txn.amount >= 10000,
  },
  {
    id: 'RULE-002',
    name: 'Contextual jurisdiction escalation',
    risk: 'High',
    reason: 'Customer, issuer, or counterparty data references a high-risk jurisdiction.',
    weight: 20,
    test: (txn) => ['North Korea', 'Iran', 'Syria', 'Russia'].includes(txn.counterpartyCountry || txn.country),
  },
  {
    id: 'RULE-003',
    name: 'Elevated same-card spend',
    risk: 'Medium',
    reason: 'Unusual cumulative spend on the same card within 24 hours.',
    weight: 35,
    test: (txn) => Number(txn.cardSpend24h) > 3000,
  },
  {
    id: 'RULE-004',
    name: 'Incomplete customer diligence',
    risk: 'Medium',
    reason: 'Customer KYC profile is pending review.',
    weight: 25,
    test: (txn) => txn.kycStatus === 'Pending Review',
  },
  {
    id: 'RULE-005',
    name: 'Low-value card testing burst',
    risk: 'High',
    reason: 'Repeated low-value card payments may indicate card testing.',
    weight: 30,
    test: (txn) => Number(txn.lowValueBurstCount) >= 5 && txn.amount < 20,
  },
];

// Converts customer and merchant risk levels into points for the profile risk score.
const riskLevelPoints = {
  LOW: 0,
  MEDIUM: 15,
  HIGH: 30,
};

// Default merchant opening hours used to check if a transaction happened at an unusual time.
const defaultOperatingHours = {
  openHour: 7,
  closeHour: 23,
};

function normalizeRiskLevel(level) {
  const normalized = String(level || 'LOW').trim().toUpperCase();
  return Object.hasOwn(riskLevelPoints, normalized) ? normalized : 'LOW';
}

function riskLevelToPoints(level) {
  return riskLevelPoints[normalizeRiskLevel(level)];
}

// Adds customer risk points and merchant risk points together.
function calculateProfileRiskScore(transaction = {}) {
  return riskLevelToPoints(transaction.customerRiskLevel) + riskLevelToPoints(transaction.merchantRiskLevel);
}

function riskLevel(score) {
  if (score >= 70) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function recommendedAction(score) {
  if (score >= 70) return 'Manual Review or Hold Settlement';
  if (score >= 50) return 'Request OTP';
  if (score >= 30) return 'Monitor';
  return 'Allow';
}

// Reads the hour from the transaction timestamp so the operating-hours rule can check it.
function getTransactionHour(transaction = {}) {
  if (Number.isInteger(transaction.transactionHour)) return transaction.transactionHour;

  const timestamp = transaction.createdAt || transaction.timestamp;
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.getHours();
}

function isOutsideOperatingHours(transactionHour, operatingHours = defaultOperatingHours) {
  if (!Number.isInteger(transactionHour)) return false;
  return transactionHour < operatingHours.openHour || transactionHour >= operatingHours.closeHour;
}

// Creates the TIME-001 rule when the transaction happens outside normal operating hours.
function buildOperatingHoursRule(transaction = {}, operatingHours = defaultOperatingHours) {
  const transactionHour = getTransactionHour(transaction);
  const operatingHoursTriggered = isOutsideOperatingHours(transactionHour, operatingHours);

  return {
    transactionHour,
    operatingHoursTriggered,
    rules: operatingHoursTriggered
      ? [{
        id: 'TIME-001',
        name: 'Transaction Outside Operating Hours',
        risk: 'Medium',
        reason: 'Transaction occurred outside normal merchant operating hours.',
        weight: 10,
        source: 'operating_hours',
      }]
      : [],
  };
}

// Creates profile risk rules when the customer or merchant is marked as high risk.
function buildProfileRiskRules(transaction = {}) {
  const rules = [];
  const customerRiskLevel = normalizeRiskLevel(transaction.customerRiskLevel);
  const merchantRiskLevel = normalizeRiskLevel(transaction.merchantRiskLevel);

  if (customerRiskLevel === 'HIGH') {
    rules.push({
      id: 'PROFILE-CUSTOMER-HIGH',
      name: 'High-risk customer profile',
      risk: 'High',
      reason: 'Customer KYC risk level is HIGH',
      weight: riskLevelToPoints(customerRiskLevel),
      source: 'profile',
    });
  }

  if (merchantRiskLevel === 'HIGH') {
    rules.push({
      id: 'PROFILE-MERCHANT-HIGH',
      name: 'High-risk merchant profile',
      risk: 'High',
      reason: 'Merchant risk level is HIGH',
      weight: riskLevelToPoints(merchantRiskLevel),
      source: 'profile',
    });
  }

  return rules;
}

<<<<<<< HEAD
// Company setup: each merchant has its own MCC, industry, risk level, and transaction rules.
=======
// Merchant-agnostic rule template: local card-payment monitoring for UNIWEB is not tied to
// any fixed set of example industries. Any merchant profile - regardless of MCC/industry -
// plugs its own typical-basket thresholds into this same template, so the detection logic
// (amount, velocity, same-card 24h spend, threshold avoidance, unfamiliar-customer spend)
// applies uniformly. Merchant risk itself is assessed separately via MCC code
// (industryRiskScore) and merchantRiskLevel, combined in calculateProfileRiskScore above.
function buildMerchantRules(merchant) {
  const {
    rulePrefix,
    mediumAmountThreshold,
    highAmountThreshold,
    velocityCount,
    cardSpend24hThreshold = 1500,
    newCustomerAmountThreshold = 800,
  } = merchant;

  return [
    {
      id: `${rulePrefix}-001`,
      name: `Single transaction above S$${mediumAmountThreshold.toLocaleString()}`,
      risk: 'Medium',
      reason: "Above this merchant profile's typical basket size",
      weight: 30,
      test: (txn) => txn.amount > mediumAmountThreshold,
    },
    {
      id: `${rulePrefix}-002`,
      name: `Single transaction above S$${highAmountThreshold.toLocaleString()}`,
      risk: 'High',
      reason: "Far above this merchant profile's typical basket size",
      weight: 55,
      test: (txn) => txn.amount > highAmountThreshold,
    },
    {
      id: `${rulePrefix}-003`,
      name: `${velocityCount}+ merchant transactions within 30 min`,
      risk: 'Medium',
      reason: 'Possible split payment or repeated card attempts',
      weight: 30,
      test: (txn) => txn.recentCompanyTransactions >= velocityCount,
    },
    {
      id: `${rulePrefix}-004`,
      name: `Same card spends above S$${cardSpend24hThreshold.toLocaleString()} within 24h`,
      risk: 'High',
      reason: 'Unusual cumulative same-card spend for this merchant profile',
      weight: 55,
      test: (txn) => txn.cardSpend24h > cardSpend24hThreshold,
    },
    {
      id: `${rulePrefix}-005`,
      name: `Several amounts just below S$${mediumAmountThreshold.toLocaleString()}`,
      risk: 'Medium',
      reason: 'Possible threshold avoidance',
      weight: 30,
      test: (txn) => txn.nearThresholdCount >= 3 && txn.amount < mediumAmountThreshold,
    },
    {
      id: `${rulePrefix}-006`,
      name: `New or usually low-spend customer above S$${newCustomerAmountThreshold.toLocaleString()}`,
      risk: 'Medium',
      reason: 'New card/account, or a sudden spend jump, plus a high-value purchase',
      weight: 35,
      test: (txn) => (txn.isNewCustomer || txn.usualSpendBelow100) && txn.amount > newCustomerAmountThreshold,
    },
  ];
}

function buildMerchantCards(merchant) {
  return [
    {
      title: 'MCC pattern (example profile)',
      tone: merchant.accent,
      text: merchant.patternText,
    },
    {
      title: 'Medium risk',
      tone: 'amber',
      text: `Above S$${merchant.mediumAmountThreshold.toLocaleString()}, ${merchant.velocityCount}+ purchases in 30 minutes, or amounts just below the threshold.`,
    },
    {
      title: 'High risk',
      tone: 'red',
      text: `Above S$${merchant.highAmountThreshold.toLocaleString()}, or same card spends above S$${(merchant.cardSpend24hThreshold ?? 1500).toLocaleString()} in 24 hours.`,
    },
  ];
}

// Example merchant profiles only - UNIWEB's local card-payment monitoring supports any
// Singapore merchant profile, not just the ones configured below. Onboarding a new merchant
// means adding another entry here with its own MCC code and thresholds; buildMerchantRules
// and buildMerchantCards above apply identically regardless of industry.
>>>>>>> bacb1382aa2c1baa513dee4bc20ac5d3e8bef032
const companyRuleSets = {
  companyA: {
    id: 'companyA',
    name: 'Merchant Profile 5651',
    merchantType: 'MCC 5651 - Family Clothing Stores',
    mccCode: '5651',
    industry: 'Family Clothing Stores',
    industryRiskScore: 8,
    merchantRiskLevel: 'LOW',
    accent: 'blue',
    rulePrefix: 'COM-A',
    mediumAmountThreshold: 700,
    highAmountThreshold: 1200,
    velocityCount: 4,
    patternText: 'Average spend is usually around S$60-S$150. Higher baskets can happen when customers buy several items in one visit.',
  },
  companyB: {
    id: 'companyB',
    name: 'Merchant Profile 5661',
    merchantType: 'MCC 5661 - Shoe Stores',
    mccCode: '5661',
    industry: 'Shoe Stores',
    industryRiskScore: 12,
    merchantRiskLevel: 'MEDIUM',
    accent: 'green',
    rulePrefix: 'COM-B',
    mediumAmountThreshold: 1000,
    highAmountThreshold: 2000,
    velocityCount: 3,
    patternText: 'Average spend is usually around S$100-S$200+, while one pair or bag can push baskets higher.',
  },
  companyC: {
    id: 'companyC',
    name: 'Merchant Profile 5977',
    merchantType: 'MCC 5977 - Cosmetic Stores',
    mccCode: '5977',
    industry: 'Cosmetic Stores',
    industryRiskScore: 10,
    merchantRiskLevel: 'HIGH',
    accent: 'purple',
    rulePrefix: 'COM-C',
    mediumAmountThreshold: 700,
    highAmountThreshold: 1000,
    velocityCount: 4,
    patternText: 'Average spend is usually around S$100-S$200. Premium items can be expensive, so review before blocking.',
  },
};

<<<<<<< HEAD
// Main risk calculator: combines MCC, profile, and detection points into the first automated risk score.
// Final risk is intentionally left for a later officer assessment step.
=======
Object.values(companyRuleSets).forEach((merchant) => {
  merchant.cards = buildMerchantCards(merchant);
  merchant.rules = buildMerchantRules(merchant);
});

>>>>>>> bacb1382aa2c1baa513dee4bc20ac5d3e8bef032
function evaluateTransaction(transaction, rules = defaultRules, additionalDetectionRules = []) {
  const mccRiskScore = Number(transaction.industryRiskScore) || Number(transaction.mccRiskScore) || 0;
  const profileRiskScore = calculateProfileRiskScore(transaction);
  const profileRiskRules = buildProfileRiskRules(transaction);
  // Apply the default merchant operating-hours rule here so future merchant-specific windows can be swapped in centrally.
  const operatingHoursCheck = buildOperatingHoursRule(transaction);
  const transactionRules = rules
    .filter((rule) => rule.test(transaction))
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      risk: rule.risk,
      reason: rule.reason,
      weight: rule.weight,
    }));
  const detectionRules = [...transactionRules, ...operatingHoursCheck.rules, ...additionalDetectionRules];
  const transactionDetectionScore = detectionRules.reduce((score, rule) => score + (Number(rule.weight) || 0), 0);
  const initialRiskScore = mccRiskScore + profileRiskScore + transactionDetectionScore;
  const triggeredRules = [...profileRiskRules, ...detectionRules];

  return {
    mccRiskScore,
    profileRiskScore,
    transactionDetectionScore,
    transactionHour: operatingHoursCheck.transactionHour,
    operatingHoursTriggered: operatingHoursCheck.operatingHoursTriggered,
    initialRiskScore,
    initialRiskLevel: riskLevel(initialRiskScore),
    recommendedAction: recommendedAction(initialRiskScore),
    triggeredRules,
    riskScore: initialRiskScore,
    matchedRules: triggeredRules,
  };
}

function riskBands(score) {
  return riskLevel(score);
}

function serializeCompanyRuleSets(ruleSets = companyRuleSets) {
  return Object.values(ruleSets).map((company) => ({
    id: company.id,
    name: company.name,
    merchantType: company.merchantType,
    mccCode: company.mccCode,
    industry: company.industry,
    industryRiskScore: company.industryRiskScore,
    merchantRiskLevel: normalizeRiskLevel(company.merchantRiskLevel),
    accent: company.accent,
    cards: company.cards,
    rules: company.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      risk: rule.risk,
      reason: rule.reason,
      weight: rule.weight,
    })),
  }));
}

module.exports = {
  defaultRules,
  companyRuleSets,
  defaultOperatingHours,
  calculateProfileRiskScore,
  evaluateTransaction,
  getTransactionHour,
  isOutsideOperatingHours,
  normalizeRiskLevel,
  recommendedAction,
  riskLevel,
  riskBands,
  riskLevelPoints,
  riskLevelToPoints,
  serializeCompanyRuleSets,
};
