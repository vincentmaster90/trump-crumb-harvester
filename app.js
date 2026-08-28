const $ = (id) => document.getElementById(id);
let state = null;
let pollTimer = null;

function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(n || 0));
}

function priceFmt(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const digits = v >= 1 ? 4 : 6;
  return `$${v.toFixed(digits)}`;
}

function pct(n) {
  const v = Number(n || 0);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderHistory() {
  const body = $('historyBody');
  if (!state?.history?.length) {
    body.innerHTML = '<tr class="empty"><td colspan="8">No harvests yet.</td></tr>';
    return;
  }
  body.innerHTML = state.history.slice().reverse().map((h) => `
    <tr>
      <td>${h.number}</td>
      <td>${new Date(h.time).toLocaleString()}</td>
      <td>${priceFmt(h.entry)}</td>
      <td>${priceFmt(h.exit)}</td>
      <td>${money(h.grossProfit)}</td>
      <td>${money(h.fees)}</td>
      <td class="positive">${money(h.netBanked)}</td>
      <td>${money(h.totalBanked)}</td>
    </tr>
  `).join('');
}

function render() {
  if (!state) return;

  $('baseCapital').value = state.baseCapital;
  $('targetPct').value = state.targetPct;
  $('feePct').value = state.feePct;

  $('currentPrice').textContent = priceFmt(state.currentPrice);
  $('entryPrice').textContent = priceFmt(state.entryPrice);
  $('targetPrice').textContent = priceFmt(state.targetPrice);
  $('bankedProfit').textContent = money(state.bankedProfit);
  $('harvestCount').textContent = String(state.harvestCount || 0);
  $('tokensHeld').textContent = Number(state.tokensHeld || 0).toFixed(6);
  $('positionValue').textContent = money(state.positionValue);
  $('totalWealth').textContent = money(state.totalWealth);

  $('unrealizedLabel').textContent = `Unrealized: ${money(state.unrealized)} • ${pct(state.cycleMovePct)}`;
  $('unrealizedLabel').className = state.cycleMovePct > 0 ? 'positive' : state.cycleMovePct < 0 ? 'negative' : '';

  $('cycleMove').textContent = state.entryPrice ? `Cycle move ${pct(state.cycleMovePct)}` : 'Waiting for first live price';
  $('cycleMove').className = state.cycleMovePct > 0 ? 'positive' : state.cycleMovePct < 0 ? 'negative' : '';

  if (state.distancePct == null) $('distanceToTarget').textContent = `Target +${Number(state.targetPct).toFixed(2)}%`;
  else if (state.distancePct <= 0) $('distanceToTarget').textContent = 'Target reached';
  else $('distanceToTarget').textContent = `${state.distancePct.toFixed(2)}% to harvest`;

  $('engineBadge').textContent = state.running ? 'RUNNING 24/7' : 'PAUSED';
  $('engineBadge').className = `badge ${state.running ? 'on' : 'off'}`;
  $('sourceBadge').textContent = 'KRAKEN LIVE';
  $('liveDot').className = `dot ${state.lastError ? '' : 'live'}`;
  $('liveStatus').textContent = state.lastError ? `Kraken error: ${state.lastError}` : 'Kraken live • server 24/7';
  $('lastUpdated').textContent = state.lastUpdated ? `Kraken • ${new Date(state.lastUpdated).toLocaleTimeString()}` : 'Connecting to Kraken…';

  $('manualPrice').disabled = true;
  $('applyPriceBtn').disabled = true;
  $('liveBtn').disabled = true;
  $('liveBtn').textContent = 'Kraken server feed active';

  renderHistory();
}

async function refreshState() {
  try {
    state = await api('/api/state');
    render();
  } catch (e) {
    $('liveDot').className = 'dot';
    $('liveStatus').textContent = 'Server connection lost';
    console.error(e);
  }
}

async function startOrResume() {
  const baseCapital = Number($('baseCapital').value || 1000);
  const targetPct = Number($('targetPct').value || 2);
  const feePct = Number($('feePct').value || 0);
  state = await api('/api/start', {
    method: 'POST',
    body: JSON.stringify({ baseCapital, targetPct, feePct, restart: false })
  });
  render();
}

async function pause() {
  state = await api('/api/pause', { method: 'POST', body: '{}' });
  render();
}

async function resetEverything() {
  if (!confirm('Reset virtual USD profit, paper position and harvest history?')) return;
  state = await api('/api/reset', { method: 'POST', body: '{}' });
  render();
}

async function refreshNow() {
  $('refreshBtn').disabled = true;
  try {
    state = await api('/api/refresh', { method: 'POST', body: '{}' });
    render();
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function exportCsv() {
  if (!state?.history?.length) return alert('No harvest history yet.');
  const rows = [
    ['number','time','entry','exit','gross_profit','fees','net_banked','total_banked'],
    ...state.history.map(h => [h.number,h.time,h.entry,h.exit,h.grossProfit,h.fees,h.netBanked,h.totalBanked])
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trump-paper-harvest-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

$('startBtn').textContent = 'Start / Resume 24/7';
$('stopBtn').textContent = 'Pause';
$('startBtn').addEventListener('click', startOrResume);
$('stopBtn').addEventListener('click', pause);
$('resetBtn').addEventListener('click', resetEverything);
$('refreshBtn').addEventListener('click', refreshNow);
$('exportBtn').addEventListener('click', exportCsv);

refreshState();
pollTimer = setInterval(refreshState, 5000);
