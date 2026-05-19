const state = {
  transactions: [],
  alerts: [],
  cases: [],
  ruleSets: [],
  auditLogs: [],
  charts: {},
  metrics: {},
  riskFilter: 'All',
  companyFilter: 'All',
};

const alertStatuses = ['Investigating', 'Escalated', 'Closed', 'False Positive'];

const money = new Intl.NumberFormat('en-SG', {
  style: 'currency',
  currency: 'SGD',
  maximumFractionDigits: 0,
});

const time = new Intl.DateTimeFormat('en-SG', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const elements = {
  totalMetric: document.querySelector('#totalMetric'),
  flagRateMetric: document.querySelector('#flagRateMetric'),
  activeAlertsMetric: document.querySelector('#activeAlertsMetric'),
  valueMetric: document.querySelector('#valueMetric'),
  transactionRows: document.querySelector('#transactionRows'),
  alertList: document.querySelector('#alertList'),
  caseList: document.querySelector('#caseList'),
  auditList: document.querySelector('#auditList'),
  ruleList: document.querySelector('#ruleList'),
  companyRuleTabs: document.querySelector('#companyRuleTabs'),
  companyRuleDetail: document.querySelector('#companyRuleDetail'),
  riskChart: document.querySelector('#riskChart'),
  dispositionChart: document.querySelector('#dispositionChart'),
  alertStatusChart: document.querySelector('#alertStatusChart'),
  countryChart: document.querySelector('#countryChart'),
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  riskFilter: document.querySelector('#riskFilter'),
  companyFilter: document.querySelector('#companyFilter'),
  simulateBtn: document.querySelector('#simulateBtn'),
};

function setSnapshot(snapshot) {
  state.transactions = snapshot.transactions || [];
  state.alerts = snapshot.alerts || [];
  state.cases = snapshot.cases || [];
  state.auditLogs = snapshot.auditLogs || [];
  state.ruleSets = snapshot.ruleSets || snapshot.rules || [];
  state.charts = snapshot.charts || {};
  state.metrics = snapshot.metrics || {};
  populateCompanyFilter();
  render();
}

function upsert(collection, item) {
  const index = collection.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    collection[index] = item;
  } else {
    collection.unshift(item);
  }
}

function populateCompanyFilter() {
  if (!elements.companyFilter) return;
  const current = elements.companyFilter.value || state.companyFilter;
  elements.companyFilter.innerHTML = '<option value="All">All Companies</option>' + state.ruleSets.map((company) => `
    <option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>
  `).join('');
  elements.companyFilter.value = state.ruleSets.some((company) => company.id === current) ? current : 'All';
  state.companyFilter = elements.companyFilter.value;
}

function matchesCompany(item) {
  return state.companyFilter === 'All' || item.companyId === state.companyFilter;
}

function getFilteredTransactions() {
  return state.transactions.filter(matchesCompany);
}

function getFilteredAlerts() {
  return state.alerts.filter(matchesCompany);
}

function getFilteredCases() {
  return state.cases.filter(matchesCompany);
}

function getFilteredAuditLogs() {
  return state.auditLogs.filter(matchesCompany);
}

function getFilteredMetrics() {
  const transactions = getFilteredTransactions();
  const alerts = getFilteredAlerts();
  const total = transactions.length;
  const flagged = transactions.filter((txn) => txn.status === 'Flagged').length;
  const activeAlerts = alerts.filter((alert) => !['Closed', 'False Positive'].includes(alert.status)).length;
  const valueScreened = transactions.reduce((sum, txn) => sum + txn.amount, 0);
  return {
    total,
    flagged,
    activeAlerts,
    valueScreened,
    flagRate: total ? Math.round((flagged / total) * 100) : 0,
  };
}

function getFilteredCharts() {
  const transactions = getFilteredTransactions();
  const alerts = getFilteredAlerts();
  const riskOrder = ['Critical', 'High', 'Medium', 'Low'];
  const alertStatusesForChart = ['Open', 'Investigating', 'Escalated', 'Closed', 'False Positive'];
  const countryCounts = transactions.reduce((summary, txn) => {
    summary[txn.country] = (summary[txn.country] || 0) + 1;
    return summary;
  }, {});

  return {
    riskCounts: riskOrder.map((risk) => ({ label: risk, value: transactions.filter((txn) => txn.riskBand === risk).length })),
    disposition: [
      { label: 'Flagged', value: transactions.filter((txn) => txn.status === 'Flagged').length },
      { label: 'Cleared', value: transactions.filter((txn) => txn.status === 'Cleared').length },
    ],
    alertStatus: alertStatusesForChart.map((status) => ({ label: status, value: alerts.filter((alert) => alert.status === status).length })),
    topCountries: Object.entries(countryCounts)
      .map(([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 6),
  };
}
function render() {
  renderMetrics();
  renderCharts();
  renderTransactions();
  renderAlerts();
  renderCases();
  renderAuditLogs();
  renderRules();
}

function renderMetrics() {
  if (!elements.totalMetric) return;
  const metrics = getFilteredMetrics();
  elements.totalMetric.textContent = metrics.total || 0;
  elements.flagRateMetric.textContent = `${metrics.flagRate || 0}%`;
  elements.activeAlertsMetric.textContent = metrics.activeAlerts || 0;
  elements.valueMetric.textContent = money.format(metrics.valueScreened || 0);
}

function renderCharts() {
  const charts = getFilteredCharts();
  renderBarChart(elements.riskChart, charts.riskCounts || []);
  renderBarChart(elements.dispositionChart, charts.disposition || []);
  renderBarChart(elements.alertStatusChart, charts.alertStatus || []);
  renderBarChart(elements.countryChart, charts.topCountries || []);
}

function renderBarChart(target, rows) {
  if (!target) return;
  const max = Math.max(...rows.map((row) => row.value), 1);
  target.innerHTML = rows.map((row) => {
    const width = Math.max((row.value / max) * 100, row.value ? 7 : 0);
    return `
      <div class="chart-row">
        <div class="chart-label">
          <span>${escapeHtml(row.label)}</span>
          <strong>${row.value}</strong>
        </div>
        <div class="chart-track"><span style="width: ${width}%"></span></div>
      </div>
    `;
  }).join('') || '<p class="muted">No chart data yet.</p>';
}

function renderTransactions() {
  if (!elements.transactionRows) return;
  const rows = getFilteredTransactions()
    .filter((txn) => state.riskFilter === 'All' || txn.riskBand === state.riskFilter)
    .slice(0, 35)
    .map((txn) => `
      <tr class="transaction-row" data-transaction-id="${escapeHtml(txn.id)}" title="View transaction details">
        <td>${time.format(new Date(txn.createdAt))}</td>
        <td>
          <strong>${escapeHtml(txn.customerName)}</strong>
          <div class="muted">${escapeHtml(txn.customerId)}</div>
        </td>
        <td><strong>${escapeHtml(txn.companyName || 'Company')}</strong><div class="muted">${escapeHtml(txn.merchantType || txn.merchantCategory)}</div></td>
        <td>${money.format(txn.amount)}</td>
        <td>${escapeHtml(txn.country)}</td>
        <td>${escapeHtml(txn.channel)}</td>
        <td><span class="badge risk-${txn.riskBand.toLowerCase()}">${txn.riskBand} ${txn.riskScore}</span></td>
        <td class="status-${txn.status.toLowerCase()}">${txn.status}</td>
      </tr>
    `)
    .join('');

  elements.transactionRows.innerHTML = rows || '<tr><td colspan="8">No transactions found.</td></tr>';
}

function renderAlerts() {
  if (!elements.alertList) return;
  elements.alertList.innerHTML = getFilteredAlerts().slice(0, 30).map((alert) => `
    <article class="alert">
      <div class="alert-top">
        <strong>${escapeHtml(alert.customerName)}</strong>
        <span class="badge risk-${alert.severity.toLowerCase()}">${alert.severity}</span>
      </div>
      <p>${alert.rules.map((rule) => escapeHtml(rule.name)).join(', ')}</p>
      <div class="meta">${escapeHtml(alert.companyName || 'Company')} &middot; ${escapeHtml(alert.transactionId)} &middot; ${time.format(new Date(alert.createdAt))} &middot; ${escapeHtml(alert.status)} &middot; ${escapeHtml(alert.analyst)}</div>
      <div class="alert-actions">
        ${alertStatuses.map((status) => `
          <button type="button" class="secondary-btn" data-alert-id="${escapeHtml(alert.id)}" data-status="${escapeHtml(status)}" ${alert.status === status ? 'disabled' : ''}>${escapeHtml(status)}</button>
        `).join('')}
      </div>
    </article>
  `).join('') || '<p class="muted">No open alerts.</p>';
}

function renderCases() {
  if (!elements.caseList) return;
  elements.caseList.innerHTML = getFilteredCases().slice(0, 30).map((item) => `
    <article class="case-item">
      <div class="case-top">
        <strong>${escapeHtml(item.id)}</strong>
        <span class="badge risk-${item.priority.toLowerCase()}">${item.priority}</span>
      </div>
      <p>${escapeHtml(item.summary)}</p>
      <div class="meta">${escapeHtml(item.companyName || 'Company')} &middot; ${escapeHtml(item.customerName)} &middot; ${escapeHtml(item.status)} &middot; Due ${new Date(item.dueAt).toLocaleDateString('en-SG')}</div>
    </article>
  `).join('') || '<p class="muted">No cases generated.</p>';
}

function renderAuditLogs() {
  if (!elements.auditList) return;
  elements.auditList.innerHTML = getFilteredAuditLogs().slice(0, 40).map((entry) => `
    <article class="audit-item">
      <div class="audit-dot"></div>
      <div>
        <div class="audit-top">
          <strong>${escapeHtml(entry.action)}</strong>
          <span>${time.format(new Date(entry.createdAt))}</span>
        </div>
        <p>${escapeHtml(entry.message || '')}</p>
        <div class="meta">${escapeHtml(entry.companyName || 'All Companies')} &middot; ${escapeHtml(entry.actor)} &middot; ${escapeHtml(entry.entityType)}${entry.entityId ? ` &middot; ${escapeHtml(entry.entityId)}` : ''}</div>
      </div>
    </article>
  `).join('') || '<p class="muted">No audit activity yet.</p>';
}

function renderRules() {
  if (!elements.companyRuleTabs || !elements.companyRuleDetail) return;
  const ruleSets = state.ruleSets || [];
  if (!ruleSets.length) {
    elements.companyRuleDetail.innerHTML = '<p class="muted">No company rules available.</p>';
    return;
  }

  const selectedId = elements.companyRuleTabs.dataset.selectedCompany || ruleSets[0].id;
  const selected = ruleSets.find((company) => company.id === selectedId) || ruleSets[0];
  elements.companyRuleTabs.dataset.selectedCompany = selected.id;

  elements.companyRuleTabs.innerHTML = ruleSets.map((company) => {
    const highCount = company.rules.filter((rule) => rule.risk === 'High').length;
    const mediumCount = company.rules.filter((rule) => rule.risk === 'Medium').length;
    return `
      <button type="button" class="rule-tab-card ${company.id === selected.id ? 'active' : ''}" data-company-id="${escapeHtml(company.id)}">
        <span class="company-label">${escapeHtml(company.name)}</span>
        <strong>${escapeHtml(company.merchantType)}</strong>
        <span class="company-rule-meta">${mediumCount} medium · ${highCount} high · ${company.rules.length} total rules</span>
      </button>
    `;
  }).join('');

  elements.companyRuleDetail.innerHTML = `
    <section class="company-rules-heading">
      <div>
        <span>${escapeHtml(selected.merchantType)}</span>
        <h2>${escapeHtml(selected.name)} rules</h2>
      </div>
      <div class="company-view-pill">Viewing ${escapeHtml(selected.name)}</div>
    </section>

    <section class="company-rule-cards">
      ${selected.cards.map((card) => `
        <article class="rule-summary-card tone-${escapeHtml(card.tone)}">
          <h3>${escapeHtml(card.title)}</h3>
          <p>${escapeHtml(card.text)}</p>
        </article>
      `).join('')}
    </section>

    <section class="panel rules-table-panel">
      <div class="table-wrap">
        <table class="rules-table">
          <thead>
            <tr>
              <th>Rule ID</th>
              <th>Rule</th>
              <th>Risk</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            ${selected.rules.map((rule) => `
              <tr>
                <td>${escapeHtml(rule.id)}</td>
                <td>${escapeHtml(rule.name)}</td>
                <td>${escapeHtml(rule.risk)}</td>
                <td>${escapeHtml(rule.reason)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}


function getTransactionDetailModal() {
  let modal = document.querySelector('#transactionDetailModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'transactionDetailModal';
  modal.className = 'detail-modal';
  modal.innerHTML = `
    <div class="detail-modal-backdrop" data-close-transaction-modal></div>
    <section class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="transactionDetailTitle">
      <button type="button" class="detail-close" data-close-transaction-modal aria-label="Close transaction details">Close</button>
      <div id="transactionDetailContent"></div>
    </section>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-transaction-modal]')) closeTransactionDetails();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTransactionDetails();
  });
  return modal;
}

function openTransactionDetails(transactionId) {
  const transaction = state.transactions.find((txn) => txn.id === transactionId);
  if (!transaction) return;

  const modal = getTransactionDetailModal();
  const content = modal.querySelector('#transactionDetailContent');
  const rules = transaction.matchedRules && transaction.matchedRules.length
    ? transaction.matchedRules.map((rule) => `
      <li>
        <strong>${escapeHtml(rule.name)}</strong>
        <span>Risk weight +${escapeHtml(rule.weight)}</span>
      </li>
    `).join('')
    : '<li><strong>No rules matched</strong><span>This transaction cleared automated screening.</span></li>';

  content.innerHTML = `
    <div class="detail-heading">
      <div>
        <span class="eyebrow">Transaction Detail</span>
        <h2 id="transactionDetailTitle">${escapeHtml(transaction.id)}</h2>
        <p>${escapeHtml(transaction.customerName)} · ${time.format(new Date(transaction.createdAt))}</p>
      </div>
      <span class="badge risk-${transaction.riskBand.toLowerCase()}">${escapeHtml(transaction.riskBand)} ${escapeHtml(transaction.riskScore)}</span>
    </div>

    <div class="detail-summary">
      <article><span>Amount</span><strong>${money.format(transaction.amount)}</strong></article>
      <article><span>Status</span><strong class="status-${transaction.status.toLowerCase()}">${escapeHtml(transaction.status)}</strong></article>
      <article><span>Direction</span><strong>${escapeHtml(transaction.direction)}</strong></article>
    </div>

    <div class="detail-grid">
      <section>
        <h3>Customer Profile</h3>
        <dl>
          <div><dt>Company</dt><dd>${escapeHtml(transaction.companyName || 'Company')}</dd></div>
          <div><dt>Customer ID</dt><dd>${escapeHtml(transaction.customerId)}</dd></div>
          <div><dt>Name</dt><dd>${escapeHtml(transaction.customerName)}</dd></div>
          <div><dt>Segment</dt><dd>${escapeHtml(transaction.segment)}</dd></div>
          <div><dt>KYC Status</dt><dd>${escapeHtml(transaction.kycStatus)}</dd></div>
        </dl>
      </section>
      <section>
        <h3>Transaction Data</h3>
        <dl>
          <div><dt>Country</dt><dd>${escapeHtml(transaction.country)}</dd></div>
          <div><dt>Channel</dt><dd>${escapeHtml(transaction.channel)}</dd></div>
          <div><dt>Merchant Category</dt><dd>${escapeHtml(transaction.merchantCategory)}</dd></div>
          <div><dt>Currency</dt><dd>${escapeHtml(transaction.currency)}</dd></div>
        </dl>
      </section>
    </div>

    <section class="rule-breakdown">
      <h3>Rule Breakdown</h3>
      <ul>${rules}</ul>
    </section>
  `;

  modal.classList.add('open');
  document.body.classList.add('modal-open');
}

function closeTransactionDetails() {
  const modal = document.querySelector('#transactionDetailModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function updateAlertStatus(alertId, status) {
  await fetch(`/api/alerts/${encodeURIComponent(alertId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, analyst: 'Analyst Ryan' }),
  });
}



if (elements.companyFilter) {
  elements.companyFilter.addEventListener('change', (event) => {
    state.companyFilter = event.target.value;
    render();
  });
}
if (elements.companyRuleTabs) {
  elements.companyRuleTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-company-id]');
    if (!tab) return;
    elements.companyRuleTabs.dataset.selectedCompany = tab.dataset.companyId;
    renderRules();
  });
}
if (elements.transactionRows) {
  elements.transactionRows.addEventListener('click', (event) => {
    const row = event.target.closest('[data-transaction-id]');
    if (!row) return;
    openTransactionDetails(row.dataset.transactionId);
  });
}
if (elements.riskFilter) {
  elements.riskFilter.addEventListener('change', (event) => {
    state.riskFilter = event.target.value;
    renderTransactions();
  });
}

if (elements.alertList) {
  elements.alertList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-alert-id]');
    if (!button) return;

    button.disabled = true;
    await updateAlertStatus(button.dataset.alertId, button.dataset.status);
  });
}

if (elements.simulateBtn) {
  elements.simulateBtn.addEventListener('click', async () => {
    elements.simulateBtn.disabled = true;
    try {
      await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Manual High-Risk Review',
          amount: 52000,
          country: 'Iran',
          merchantCategory: 'Crypto Exchange',
          channel: 'Bank Transfer',
          direction: 'Outbound',
          actor: 'Analyst Ryan',
        }),
      });
    } finally {
      elements.simulateBtn.disabled = false;
    }
  });
}

fetch('/api/snapshot')
  .then((response) => response.json())
  .then(setSnapshot);

const stream = new EventSource('/api/stream');

stream.addEventListener('open', () => {
  elements.connectionDot?.classList.add('online');
  if (elements.connectionText) elements.connectionText.textContent = 'Live stream connected';
});

stream.addEventListener('snapshot', (event) => {
  setSnapshot(JSON.parse(event.data));
});

stream.addEventListener('transaction', (event) => {
  upsert(state.transactions, JSON.parse(event.data));
  renderTransactions();
});

stream.addEventListener('alert', (event) => {
  upsert(state.alerts, JSON.parse(event.data));
  renderAlerts();
});

stream.addEventListener('alertUpdate', (event) => {
  upsert(state.alerts, JSON.parse(event.data));
  renderAlerts();
});

stream.addEventListener('case', (event) => {
  upsert(state.cases, JSON.parse(event.data));
  renderCases();
});

stream.addEventListener('audit', (event) => {
  upsert(state.auditLogs, JSON.parse(event.data));
  renderAuditLogs();
});

stream.addEventListener('metrics', (event) => {
  state.metrics = JSON.parse(event.data);
  renderMetrics();
});

stream.addEventListener('charts', (event) => {
  state.charts = JSON.parse(event.data);
  renderCharts();
});

stream.addEventListener('error', () => {
  elements.connectionDot?.classList.remove('online');
  if (elements.connectionText) elements.connectionText.textContent = 'Reconnecting';
});
















