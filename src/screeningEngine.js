const watchlist = [
  {
    id: 'WL-SAN-001',
    name: 'Orion Trade Holdings',
    type: 'Sanctions',
    country: 'Iran',
    risk: 'Critical',
    reason: 'Sanctions list match for contextual payment party',
  },
  {
    id: 'WL-SAN-002',
    name: 'Baltic Petro Services',
    type: 'Sanctions',
    country: 'Russia',
    risk: 'Critical',
    reason: 'Sanctions exposure through restricted petroleum services',
  },
  {
    id: 'WL-PEP-001',
    name: 'Maya Wong',
    type: 'PEP',
    country: 'Singapore',
    risk: 'High',
    reason: 'Politically exposed person requiring enhanced monitoring',
  },
  {
    id: 'WL-ADV-001',
    name: 'Northbridge Luxury Resale',
    type: 'Adverse Media',
    country: 'United Arab Emirates',
    risk: 'High',
    reason: 'Adverse media linked to suspicious luxury-goods activity',
  },
  {
    id: 'WL-WCH-001',
    name: 'Crimson Exchange',
    type: 'Watchlist',
    country: 'Thailand',
    risk: 'Medium',
    reason: 'Internal watchlist for unusual transaction velocity',
  },
];

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(input, target) {
  const normalizedInput = normalize(input);
  const normalizedTarget = normalize(target);
  if (!normalizedInput || !normalizedTarget) return 0;
  if (normalizedInput === normalizedTarget) return 100;
  if (normalizedInput.includes(normalizedTarget) || normalizedTarget.includes(normalizedInput)) return 92;

  const inputTokens = new Set(normalizedInput.split(' '));
  const targetTokens = normalizedTarget.split(' ');
  const hits = targetTokens.filter((token) => inputTokens.has(token)).length;
  return Math.round((hits / Math.max(targetTokens.length, 1)) * 82);
}

function screenName({ name, country, field }) {
  return watchlist
    .map((entry) => {
      const score = nameScore(name, entry.name);
      const countryBoost = country && entry.country === country ? 8 : 0;
      return {
        ...entry,
        field,
        input: name,
        score: Math.min(100, score + countryBoost),
      };
    })
    .filter((match) => match.score >= 75)
    .sort((left, right) => right.score - left.score);
}

function screenCustomer(customer) {
  const matches = screenName({
    name: customer.name || customer.customerName,
    country: customer.country,
    field: 'Customer',
  });
  return {
    matches,
    highestScore: matches[0]?.score || 0,
    status: matches.length ? 'Potential Match' : 'Clear',
  };
}

function screenPayment(payment) {
  const matches = [
    ...screenName({
      name: payment.customerName,
      country: payment.country,
      field: 'Customer',
    }),
    ...screenName({
      name: payment.counterpartyName,
      country: payment.counterpartyCountry || payment.country,
      field: 'Context Party',
    }),
  ];

  const reference = normalize(payment.paymentReference);
  watchlist.forEach((entry) => {
    const entryName = normalize(entry.name);
    if (reference && entryName && reference.includes(entryName)) {
      matches.push({
        ...entry,
        field: 'Payment Details',
        input: payment.paymentReference,
        score: 88,
      });
    }
  });

  const deduped = Object.values(matches.reduce((summary, match) => {
    const key = `${match.id}-${match.field}`;
    if (!summary[key] || summary[key].score < match.score) summary[key] = match;
    return summary;
  }, {})).sort((left, right) => right.score - left.score);

  return {
    matches: deduped,
    highestScore: deduped[0]?.score || 0,
    status: deduped.length ? 'Potential Match' : 'Clear',
  };
}

module.exports = {
  screenCustomer,
  screenPayment,
  watchlist,
};
