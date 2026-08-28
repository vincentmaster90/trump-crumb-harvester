const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'trump-crumb-harvester-state-v1';
const DEFAULTS = {
  baseCapital: 10000,
  targetPct: 2,
  feePct: 0,
  currentPrice: null,
  entryPrice: null,
  tokensHeld: 0,
  bankedProfit: 0,
  harvestCount: 0,
  running: false,
  liveMode: false,
  history: []
};

let state = loadState();
let liveTimer = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

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

function configuredBase() {
  return Math.max(0, Number($('baseCapital').value) || 0);
}

function configuredTarget() {
  return Math.max(0.01, Number($('targetPct').value) || 2);
}

function configuredFee() {
  return Math.max(0, Number($('feePct').value) || 0);
}

function positionValue() {
  if (!state.entryPrice || !state.currentPrice || !state.tokensHeld) return 0;
  return state.tokensHeld * state.currentPrice;
}

function targetPrice() {
  if (!state.entryPrice) return null;
  return state.entryPrice * (1 + state.targetPct / 100);
}

function cycleMovePct() {
  if (!state.entryPrice || !state.currentPrice) return 0;
  return ((state.currentPrice / state.entryPrice) - 1) * 100;
}

function totalWealth() {
  const active = state.running ? positionValue() : state.baseCapital;
  return active + state.bankedProfit;
}

function render() {
  $('baseCapital').value = state.baseCapital;
  $('targetPct').value = state.targetPct;
  $('feePct').value = state.feePct;

  $('currentPrice').textContent = priceFmt(state.currentPrice);
  $('entryPrice').textContent = priceFmt(state.entryPrice);
  $('targetPrice').textContent = priceFmt(targetPrice());
  $('bankedProfit').textContent = money(state.bankedProfit);
  $('harvestCount').textContent = String(state.harvestCount);
  $('tokensHeld').textContent = state.tokensHeld ? state.tokensHeld.toFixed(6) : '0.000000';
  $('positionValue').textContent = money(positionValue());
  $('totalWealth').textContent = money(totalWealth());

  const unrealized = state.running ? positionValue() - state.baseCapital : 0;
  $('unrealizedLabel').textContent = `Unrealized: ${money(unrealized)}`;
  $('unrealizedLabel').className = unrealized > 0 ? 'positive' : unrealized < 0 ? 'negative' : '';

  if (state.entryPrice && state.currentPrice) {
    const move = cycleMovePct();
    $('cycleMove').textContent = `Cycle move ${pct(move)}`;
    $('cycleMove').className = move > 0 ? 'positive' : move < 0 ? 'negative' : '';
    const distance = ((targetPrice() / state.currentPrice) - 1) * 100;
    $('distanceToTarget').textContent = distance <= 0 ? 'Target reached' : `${distance.toFixed(2)}% to harvest`;
  } else {
    $('cycleMove').textContent = 'Start a cycle';
    $('cycleMove').className = '';
    $('distanceToTarget').textContent = `Target +${state.targetPct.toFixed(2)}%`;
  }

  $('engineBadge').textContent = state.running ? 'RUNNING' : 'STOPPED';
  $('engineBadge').className = `badge ${state.running ? 'on' : 'off'}`;
  $('sourceBadge').textContent = state.liveMode ? 'LIVE' : 'MANUAL';
  $('liveDot').className = `dot ${state.liveMode ? 'live' : ''}`;
  $('liveStatus').textContent = state.liveMode ? 'Live price mode' : 'Manual price mode';

  renderHistory();
  saveState();
}

function renderHistory() {
  const body = $('historyBody');
  if (!state.history.length) {
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

function startCycle() {
  state.baseCapital = configuredBase();
  state.targetPct = configuredTarget();
  state.feePct = configuredFee();

  if (!state.currentPrice || state.currentPrice <= 0) {
    alert('Set a TRUMP price first or use live price mode.');
    return;
  }

  state.entryPrice = state.currentPrice;
  state.tokensHeld = state.baseCapital / state.entryPrice;
  state.running = true;
  render();
}

function stopCycle() {
  state.running = false;
  render();
}

function setPrice(price, source = 'manual') {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  state.currentPrice = p;
  $('lastUpdated').textContent = `${source === 'live' ? 'Live' : 'Manual'} • ${new Date().toLocaleTimeString()}`;
  evaluateHarvest();
  render();
}

function evaluateHarvest() {
  if (!state.running || !state.entryPrice || !state.currentPrice) return;
  const target = targetPrice();
  if (state.currentPrice + Number.EPSILON < target) return;

  const exitValue = state.tokensHeld * state.currentPrice;
  const grossProfit = exitValue - state.baseCapital;

  const buyFee = state.baseCapital * (state.feePct / 100);
  const sellFee = exitValue * (state.feePct / 100);
  const fees = buyFee + sellFee;
  const netBanked = grossProfit - fees;

  state.bankedProfit += netBanked;
  state.harvestCount += 1;
  state.history.push({
    number: state.harvestCount,
    time: new Date().toISOString(),
    entry: state.entryPrice,
    exit: state.currentPrice,
    grossProfit,
    fees,
    netBanked,
    totalBanked: state.bankedProfit
  });

  // Immediate re-entry using exactly the same fixed base capital.
  state.entryPrice = state.currentPrice;
  state.tokensHeld = state.baseCapital / state.entryPrice;
}

async function fetchLivePrice() {
  try {
    $('refreshBtn').disabled = true;
    $('liveStatus').textContent = 'Fetching TRUMP price…';
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=official-trump&vs_currencies=usd';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const value = data?.['official-trump']?.usd;
    if (!value) throw new Error('TRUMP price missing');
    state.liveMode = true;
    setPrice(value, 'live');
  } catch (err) {
    state.liveMode = false;
    $('liveStatus').textContent = 'Live fetch failed — use manual price';
    console.error(err);
    render();
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function enableLiveMode() {
  state.liveMode = true;
  fetchLivePrice();
  clearInterval(liveTimer);
  liveTimer = setInterval(fetchLivePrice, 30000);
}

function resetEverything() {
  if (!confirm('Reset banked profit, position and harvest history?')) return;
  state = { ...DEFAULTS, currentPrice: state.currentPrice, liveMode: state.liveMode };
  render();
}

function exportCsv() {
  if (!state.history.length) {
    alert('No harvest history to export yet.');
    return;
  }
  const rows = [
    ['number','time','entry','exit','gross_profit','fees','net_banked','total_banked'],
    ...state.history.map(h => [h.number,h.time,h.entry,h.exit,h.grossProfit,h.fees,h.netBanked,h.totalBanked])
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trump-harvest-history-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

$('startBtn').addEventListener('click', startCycle);
$('stopBtn').addEventListener('click', stopCycle);
$('resetBtn').addEventListener('click', resetEverything);
$('applyPriceBtn').addEventListener('click', () => {
  state.liveMode = false;
  clearInterval(liveTimer);
  setPrice($('manualPrice').value, 'manual');
});
$('liveBtn').addEventListener('click', enableLiveMode);
$('refreshBtn').addEventListener('click', fetchLivePrice);
$('exportBtn').addEventListener('click', exportCsv);

['baseCapital','targetPct','feePct'].forEach(id => {
  $(id).addEventListener('change', () => {
    if (state.running) return;
    state.baseCapital = configuredBase();
    state.targetPct = configuredTarget();
    state.feePct = configuredFee();
    render();
  });
});

render();
