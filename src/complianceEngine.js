const defaultRules = [
  {
    id: 'RULE-001',
    name: 'Large transaction threshold',
    description: 'Flags transactions equal to or above SGD 10,000.',
    weight: 35,
    test: (txn) => txn.amount >= 10000,
  },
  {
    id: 'RULE-002',
    name: 'High-risk jurisdiction',
    description: 'Flags transactions involving sanctioned or high-risk countries.',
    weight: 40,
    test: (txn) => ['North Korea', 'Iran', 'Syria', 'Russia'].includes(txn.country),
  },
  {
    id: 'RULE-003',
    name: 'Crypto or money transfer activity',
    description: 'Raises risk for crypto exchange and money transfer merchant categories.',
    weight: 20,
    test: (txn) => ['Crypto Exchange', 'Money Transfer'].includes(txn.merchantCategory),
  },
  {
    id: 'RULE-004',
    name: 'Incomplete customer diligence',
    description: 'Flags customers whose KYC profile is pending review.',
    weight: 25,
    test: (txn) => txn.kycStatus === 'Pending Review',
  },
  {
    id: 'RULE-005',
    name: 'Large outbound funds movement',
    description: 'Flags outbound transfers above SGD 25,000.',
    weight: 30,
    test: (txn) => txn.direction === 'Outbound' && txn.amount > 25000,
  },
];

const riskLevelPoints = {
  LOW: 0,
  MEDIUM: 15,
  HIGH: 30,
};

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

const companyRuleSets = {
  companyA: {
    id: 'companyA',
    name: 'Company A',
    merchantType: 'Fashion Merchant',
    mccCode: '5651',
    industry: 'Family Clothing Stores',
    industryRiskScore: 8,
    merchantRiskLevel: 'LOW',
    accent: 'blue',
    cards: [
      {
        title: 'Merchant pattern',
        tone: 'blue',
        text: 'Average spend is usually around S$60-S$150. Higher baskets can happen when customers buy several clothing items or bags.',
      },
      {
        title: 'Medium risk',
        tone: 'amber',
        text: 'Above S$700 or several payments just below S$700. Review, but do not auto-decline immediately.',
      },
      {
        title: 'High risk',
        tone: 'red',
        text: 'Above S$1,200, or same card spends above S$1,500 in 24 hours.',
      },
      {
        title: 'Extra watch',
        tone: 'purple',
        text: 'New card plus high first purchase.',
      },
    ],
    rules: [
      { id: 'COM-A-001', name: 'Single transaction above S$700', risk: 'Medium', reason: 'Above expected clothing basket', weight: 30, test: (txn) => txn.amount > 700 },
      { id: 'COM-A-002', name: 'Single transaction above S$1,200', risk: 'High', reason: 'Unusual for ordinary fashion purchase', weight: 55, test: (txn) => txn.amount > 1200 },
      { id: 'COM-A-003', name: '4+ Company A transactions within 30 min', risk: 'Medium', reason: 'Possible split payment or repeated attempts', weight: 30, test: (txn) => txn.recentCompanyTransactions >= 4 },
      { id: 'COM-A-004', name: 'Same card spends above S$1,500 within 24h', risk: 'High', reason: 'Unusual cumulative fashion spend', weight: 55, test: (txn) => txn.cardSpend24h > 1500 },
      { id: 'COM-A-005', name: 'Several amounts just below S$700', risk: 'Medium', reason: 'Possible threshold avoidance', weight: 30, test: (txn) => txn.nearThresholdCount >= 3 && txn.amount < 700 },
      { id: 'COM-A-006', name: 'New customer first purchase above S$800', risk: 'Medium', reason: 'New card/account plus high-value spend', weight: 35, test: (txn) => txn.isNewCustomer && txn.amount > 800 },
    ],
  },
  companyB: {
    id: 'companyB',
    name: 'Company B',
    merchantType: 'Footwear And Leather Goods',
    mccCode: '5661',
    industry: 'Shoe Stores',
    industryRiskScore: 12,
    merchantRiskLevel: 'MEDIUM',
    accent: 'green',
    cards: [
      {
        title: 'Merchant pattern',
        tone: 'green',
        text: 'Average spend is usually around S$100-S$200+, while one pair or bag can push baskets higher.',
      },
      {
        title: 'Medium risk',
        tone: 'amber',
        text: 'Above S$1,000, 3+ purchases in 30 minutes, or near-threshold amounts.',
      },
      {
        title: 'High risk',
        tone: 'red',
        text: 'Above S$2,000, or same card spends above S$1,500 in 24 hours.',
      },
    ],
    rules: [
      { id: 'COM-B-001', name: 'Single transaction above S$1,000', risk: 'Medium', reason: 'Likely multiple pairs or leather goods', weight: 30, test: (txn) => txn.amount > 1000 },
      { id: 'COM-B-002', name: 'Single transaction above S$2,000', risk: 'High', reason: 'Far above normal footwear basket', weight: 60, test: (txn) => txn.amount > 2000 },
      { id: 'COM-B-003', name: '3+ Company B purchases within 30 min', risk: 'Medium', reason: 'Repeated attempts, split purchase, or card testing', weight: 35, test: (txn) => txn.recentCompanyTransactions >= 3 },
      { id: 'COM-B-004', name: 'Same card spends above S$1,500 within 24h', risk: 'High', reason: 'Unusual same-day cumulative spending', weight: 55, test: (txn) => txn.cardSpend24h > 1500 },
      { id: 'COM-B-005', name: 'Many amounts just below S$1,000', risk: 'Medium', reason: 'Possible threshold avoidance', weight: 30, test: (txn) => txn.nearThresholdCount >= 3 && txn.amount < 1000 },
      { id: 'COM-B-006', name: 'Customer usually below S$100, suddenly above S$800', risk: 'Medium', reason: 'Possible account takeover or stolen card use', weight: 35, test: (txn) => txn.usualSpendBelow100 && txn.amount > 800 },
    ],
  },
  companyC: {
    id: 'companyC',
    name: 'Company C',
    merchantType: 'Skincare And Makeup Merchant',
    mccCode: '5977',
    industry: 'Cosmetic Stores',
    industryRiskScore: 10,
    merchantRiskLevel: 'HIGH',
    accent: 'purple',
    cards: [
      {
        title: 'Merchant pattern',
        tone: 'purple',
        text: 'Average spend is usually around S$100-S$200. Premium skincare sets can be expensive, so review before blocking.',
      },
      {
        title: 'Medium risk',
        tone: 'amber',
        text: 'Above S$700, new customer above S$800, or 4+ purchases within 30 minutes.',
      },
      {
        title: 'High risk',
        tone: 'red',
        text: 'Above S$1,000, or same card spends above S$1,500 in 24 hours.',
      },
    ],
    rules: [
      { id: 'COM-C-001', name: 'Single transaction above S$700', risk: 'Medium', reason: 'Higher than normal skincare/makeup basket', weight: 30, test: (txn) => txn.amount > 700 },
      { id: 'COM-C-002', name: 'Single transaction above S$1,000', risk: 'High', reason: 'Unusual unless buying many premium items', weight: 55, test: (txn) => txn.amount > 1000 },
      { id: 'COM-C-003', name: '4+ Company C purchases within 30 min', risk: 'Medium', reason: 'Possible split purchase or repeated attempts', weight: 30, test: (txn) => txn.recentCompanyTransactions >= 4 },
      { id: 'COM-C-004', name: 'Same card spends above S$1,500 within 24h', risk: 'High', reason: 'Unusual same-day cumulative spend', weight: 55, test: (txn) => txn.cardSpend24h > 1500 },
      { id: 'COM-C-005', name: '5+ low-value transactions below S$20 in 10 min', risk: 'High', reason: 'Possible card testing', weight: 55, test: (txn) => txn.lowValueBurstCount >= 5 && txn.amount < 20 },
      { id: 'COM-C-006', name: 'New customer first purchase above S$800', risk: 'Medium', reason: 'New card/account plus high-value spend', weight: 35, test: (txn) => txn.isNewCustomer && txn.amount > 800 },
    ],
  },
};

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
  const finalRiskScore = mccRiskScore + profileRiskScore + transactionDetectionScore;
  const triggeredRules = [...profileRiskRules, ...detectionRules];

  return {
    mccRiskScore,
    profileRiskScore,
    transactionDetectionScore,
    transactionHour: operatingHoursCheck.transactionHour,
    operatingHoursTriggered: operatingHoursCheck.operatingHoursTriggered,
    finalRiskScore,
    riskLevel: riskLevel(finalRiskScore),
    recommendedAction: recommendedAction(finalRiskScore),
    triggeredRules,
    riskScore: finalRiskScore,
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
