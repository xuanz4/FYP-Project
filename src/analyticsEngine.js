const closedStatuses = ['Resolved', 'False Positive'];

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function sortSummary(summary, limit = 5) {
  return Object.entries(summary)
    .map(([label, item]) => ({ label, ...item }))
    .sort((left, right) => right.score - left.score || right.count - left.count)
    .slice(0, limit);
}

function buildAnalytics(transactions = [], alerts = [], cases = []) {
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const highRisk = transactions.filter((txn) => ['High', 'Critical'].includes(txn.riskBand)).length;
  const activeAlerts = alerts.filter((alert) => !closedStatuses.includes(alert.status)).length;
  const escalatedAlerts = alerts.filter((alert) => alert.status === 'Escalated').length;
  const overdueCases = cases.filter((item) => item.dueAt && new Date(item.dueAt).getTime() < Date.now()).length;

  const ruleDrivers = {};
  const countryExposure = {};
  const companyExposure = {};
  const customerExposure = {};

  transactions.forEach((txn) => {
    const transactionScore = Number(txn.riskScore) || 0;
    const country = txn.country || 'Unknown';
    const company = txn.companyName || txn.companyId || 'Unknown Company';
    const customer = txn.customerName || txn.customerId || 'Unknown Customer';

    countryExposure[country] ||= { count: 0, flagged: 0, amount: 0, score: 0 };
    countryExposure[country].count += 1;
    countryExposure[country].flagged += txn.status === 'Flagged' ? 1 : 0;
    countryExposure[country].amount += Number(txn.amount) || 0;
    countryExposure[country].score += transactionScore;

    companyExposure[company] ||= { count: 0, flagged: 0, amount: 0, score: 0 };
    companyExposure[company].count += 1;
    companyExposure[company].flagged += txn.status === 'Flagged' ? 1 : 0;
    companyExposure[company].amount += Number(txn.amount) || 0;
    companyExposure[company].score += transactionScore;

    customerExposure[customer] ||= { count: 0, flagged: 0, amount: 0, score: 0, customerId: txn.customerId };
    customerExposure[customer].count += 1;
    customerExposure[customer].flagged += txn.status === 'Flagged' ? 1 : 0;
    customerExposure[customer].amount += Number(txn.amount) || 0;
    customerExposure[customer].score += transactionScore;

    (txn.matchedRules || []).forEach((rule) => {
      ruleDrivers[rule.name] ||= { count: 0, score: 0, weight: 0 };
      ruleDrivers[rule.name].count += 1;
      ruleDrivers[rule.name].weight += Number(rule.weight) || 0;
      ruleDrivers[rule.name].score += Number(rule.weight) || 0;
    });
  });

  const companyRows = sortSummary(companyExposure, 5).map((item) => ({
    ...item,
    flagRate: pct(item.flagged, item.count),
    averageRisk: item.count ? Math.round(item.score / item.count) : 0,
  }));

  const countryRows = sortSummary(countryExposure, 5).map((item) => ({
    ...item,
    flagRate: pct(item.flagged, item.count),
    averageRisk: item.count ? Math.round(item.score / item.count) : 0,
  }));

  const customerRows = sortSummary(customerExposure, 5).map((item) => ({
    ...item,
    flagRate: pct(item.flagged, item.count),
    averageRisk: item.count ? Math.round(item.score / item.count) : 0,
  }));

  const driverRows = sortSummary(ruleDrivers, 6).map((item) => ({
    ...item,
    averageWeight: item.count ? Math.round(item.weight / item.count) : 0,
  }));

  const insights = [];
  if (pct(flagged, total) >= 35) {
    insights.push('Flag rate is elevated. Review threshold tuning and recent merchant activity.');
  }
  if (highRisk >= 5) {
    insights.push('High and critical risk transactions are building up. Prioritize escalation review.');
  }
  if (activeAlerts >= 10) {
    insights.push('Active alert workload is high. Assign analysts before SLA pressure increases.');
  }
  if (escalatedAlerts > 0) {
    insights.push('Escalated alerts are present. Confirm investigation notes and next actions.');
  }
  if (overdueCases > 0) {
    insights.push('Some cases are past due. Reorder the queue by due date and priority.');
  }
  if (!insights.length) {
    insights.push('Current monitoring activity is stable. Keep watching for new high-risk rule clusters.');
  }

  return {
    summary: {
      total,
      flagged,
      highRisk,
      activeAlerts,
      escalatedAlerts,
      overdueCases,
      flagRate: pct(flagged, total),
      highRiskRate: pct(highRisk, total),
    },
    insights,
    drivers: driverRows,
    countries: countryRows,
    companies: companyRows,
    customers: customerRows,
  };
}

module.exports = {
  buildAnalytics,
};
