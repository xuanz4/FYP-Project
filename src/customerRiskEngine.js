const { screenCustomer } = require('./screeningEngine');
const { calculateProfileRiskScore, normalizeRiskLevel } = require('./complianceEngine');

const closedAlertStatuses = ['Resolved', 'False Positive'];
const highRiskCountries = ['North Korea', 'Iran', 'Syria', 'Russia'];

function riskBand(score) {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'High';
  if (score >= 35) return 'Medium';
  return 'Low';
}

// Builds the customer risk table by combining KYC, screening, alerts, and transaction history.
function buildCustomerRiskProfiles(transactions = [], alerts = []) {
  const profiles = {};

  transactions.forEach((txn) => {
    const key = txn.customerId || txn.customerName;
    profiles[key] ||= {
      customerId: txn.customerId,
      customerName: txn.customerName,
      segment: txn.segment,
      kycStatus: txn.kycStatus,
      customerRiskLevel: normalizeRiskLevel(txn.customerRiskLevel),
      merchantRiskLevel: normalizeRiskLevel(txn.merchantRiskLevel),
      profileRiskScore: calculateProfileRiskScore(txn),
      country: txn.country,
      companyId: txn.companyId,
      companyName: txn.companyName,
      transactionCount: 0,
      flaggedCount: 0,
      highRiskCountryCount: 0,
      screeningMatchCount: 0,
      totalValue: 0,
      maxRiskScore: 0,
      openAlerts: 0,
      riskDrivers: [],
    };

    const profile = profiles[key];
    profile.transactionCount += 1;
    profile.flaggedCount += txn.status === 'Flagged' ? 1 : 0;
    profile.highRiskCountryCount += highRiskCountries.includes(txn.country) ? 1 : 0;
    profile.screeningMatchCount += (txn.screeningMatches || []).length;
    profile.totalValue += Number(txn.amount) || 0;
    profile.maxRiskScore = Math.max(profile.maxRiskScore, Number(txn.riskScore) || 0);
    profile.country = txn.country;
    profile.companyId = txn.companyId;
    profile.companyName = txn.companyName;
    profile.kycStatus = txn.kycStatus;
    profile.customerRiskLevel = normalizeRiskLevel(txn.customerRiskLevel);
    profile.merchantRiskLevel = normalizeRiskLevel(txn.merchantRiskLevel);
    profile.profileRiskScore = calculateProfileRiskScore(txn);
    profile.segment = txn.segment;
  });

  alerts.forEach((alert) => {
    const key = alert.customerId || alert.customerName;
    if (!profiles[key]) return;
    profiles[key].openAlerts += closedAlertStatuses.includes(alert.status) ? 0 : 1;
  });

  return Object.values(profiles)
    .map((profile) => {
      const screening = screenCustomer({
        name: profile.customerName,
        country: profile.country,
      });
      const drivers = [];
      let score = 0;

      if (profile.kycStatus === 'Pending Review') {
        score += 25;
        drivers.push('KYC pending review');
      }
      if (profile.kycStatus === 'Enhanced Due Diligence') {
        score += 15;
        drivers.push('Enhanced due diligence profile');
      }
      if (profile.profileRiskScore) {
        score += profile.profileRiskScore;
        drivers.push(`Profile risk score ${profile.profileRiskScore}`);
      }
      if (profile.flaggedCount) {
        score += Math.min(30, profile.flaggedCount * 10);
        drivers.push(`${profile.flaggedCount} flagged transaction(s)`);
      }
      if (profile.openAlerts) {
        score += Math.min(20, profile.openAlerts * 8);
        drivers.push(`${profile.openAlerts} active alert(s)`);
      }
      if (profile.highRiskCountryCount) {
        score += 20;
        drivers.push('High-risk geography exposure');
      }
      if (screening.matches.length || profile.screeningMatchCount) {
        score += screening.matches.some((match) => match.type === 'Sanctions') ? 45 : 25;
        drivers.push('Screening list match');
      }
      if (profile.maxRiskScore >= 80) {
        score += 20;
        drivers.push('Critical transaction history');
      }

      const riskScore = Math.min(100, score);
      return {
        ...profile,
        riskScore,
        riskBand: riskBand(riskScore),
        riskDrivers: drivers.length ? drivers : ['No elevated customer risk indicators'],
        screeningStatus: screening.status,
        screeningMatches: screening.matches,
      };
    })
    .sort((left, right) => right.riskScore - left.riskScore || right.totalValue - left.totalValue);
}

module.exports = {
  buildCustomerRiskProfiles,
};
