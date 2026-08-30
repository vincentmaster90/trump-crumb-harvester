const $ = (id) => document.getElementById(id);
let state = null;
const ASSETS = ['TRUMP','SOL','BTC','DOGE','WIF'];
const TARGETS = [0.5,1,2];
const botId = (symbol,target) => `${symbol}_${String(target).replace('.', '_')}`;

function money(n) {
  return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:2 }).format(Number(n || 0));
}
function priceFmt(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n); return `$${v.toLocaleString('en-US',{minimumFractionDigits:v>=100?2:4,maximumFractionDigits:v>=100?2:8})}`;
}
function pct(n) { const v=Number(n||0); return `${v>=0?'+':''}${v.toFixed(2)}%`; }
function pnlClass(n) { return Number(n)>0?'positive':Number(n)<0?'negative':''; }
async function api(path, options={}) {
  const res = await fetch(path,{cache:'no-store',headers:{'content-type':'application/json',...(options.headers||{})},...options});
  if(!res.ok) throw new Error(`HTTP ${res.status}`); return res.json();
}

function targetCard(b) {
  return `<article class="panel" id="card-${b.id}">
    <div class="panel-head"><div><p class="eyebrow">${b.symbol} • ${b.targetPct}% TARGET</p><h2>${b.symbol} ${b.targetPct}% Bot</h2></div><span class="badge ${b.running?'on':'off'}">${b.running?'RUNNING':'PAUSED'}</span></div>
    <div class="grid stats lower">
      <article class="card accent"><span>Live price</span><strong>${priceFmt(b.currentPrice)}</strong><small>${b.lastError ? b.lastError : 'Kraken live'}</small></article>
      <article class="card"><span>Cycle entry</span><strong>${priceFmt(b.entryPrice)}</strong><small class="${pnlClass(b.cycleMovePct)}">${pct(b.cycleMovePct)}</small></article>
      <article class="card profit"><span>Banked profit</span><strong>${money(b.bankedProfit)}</strong><small>${b.harvestCount} harvests</small></article>
      <article class="card"><span>Net result</span><strong class="${pnlClass(b.netResult)}">${money(b.netResult)}</strong><small>Banked + unrealized</small></article>
    </div>
    <div class="formula"><strong>Current position</strong><p>${money(b.positionValue)} • Unrealized <span class="${pnlClass(b.unrealized)}">${money(b.unrealized)}</span> • Total wealth ${money(b.totalWealth)}</p></div>
  </article>`;
}

function renderTotals() {
  const bots = Object.values(state.bots);
  const totalCapital = bots.reduce((sum,b)=>sum + Number(b.baseCapital || 0),0);
  const totalBanked = bots.reduce((sum,b)=>sum + Number(b.bankedProfit || 0),0);
  const totalPositions = bots.reduce((sum,b)=>sum + Number(b.positionValue || 0),0);
  const totalWealth = bots.reduce((sum,b)=>sum + Number(b.totalWealth || 0),0);
  const totalHarvests = bots.reduce((sum,b)=>sum + Number(b.harvestCount || 0),0);
  const totalPnL = totalWealth - totalCapital;
  $('totalCapital').textContent = money(totalCapital);
  $('totalBanked').textContent = money(totalBanked);
  $('totalPositions').textContent = money(totalPositions);
  $('totalWealth').textContent = money(totalWealth);
  $('totalHarvests').textContent = `${totalHarvests} harvest${totalHarvests === 1 ? '' : 's'}`;
  $('totalPnL').textContent = `${totalPnL >= 0 ? '+' : ''}${money(totalPnL)} vs base`;
  $('totalPnL').className = pnlClass(totalPnL);
}

function renderScoreboard() {
  const rows = [];
  for (const symbol of ASSETS) {
    for (const target of TARGETS) {
      const b = state.bots[botId(symbol,target)];
      rows.push(`<tr><td><strong>${symbol}</strong></td><td><strong>${target.toFixed(1)}%</strong></td><td>${priceFmt(b.currentPrice)}</td><td>${money(b.baseCapital)}</td><td class="${pnlClass(b.cycleMovePct)}">${pct(b.cycleMovePct)}</td><td>${b.harvestCount}</td><td class="positive">${money(b.bankedProfit)}</td><td class="${pnlClass(b.unrealized)}">${money(b.unrealized)}</td><td class="${pnlClass(b.netResult)}"><strong>${money(b.netResult)}</strong></td><td>${money(b.totalWealth)}</td></tr>`);
    }
  }
  $('scoreBody').innerHTML = rows.join('');
}

function renderWinners() {
  $('winnerBody').innerHTML = ASSETS.map(symbol => {
    const variants = TARGETS.map(t=>state.bots[botId(symbol,t)]);
    const best = [...variants].sort((a,b)=>Number(b.netResult)-Number(a.netResult))[0];
    return `<tr><td><strong>${symbol}</strong></td><td><strong>${best.targetPct.toFixed(1)}%</strong></td><td>${best.harvestCount}</td><td class="positive">${money(best.bankedProfit)}</td><td class="${pnlClass(best.netResult)}"><strong>${money(best.netResult)}</strong></td></tr>`;
  }).join('');
}

function render() {
  if(!state?.bots) return;
  renderTotals();
  renderScoreboard();
  renderWinners();
  $('botsGrid').innerHTML = ASSETS.map(symbol => TARGETS.map(target=>targetCard(state.bots[botId(symbol,target)])).join('')).join('');
  const bots = Object.values(state.bots);
  const errors = bots.filter(b=>b.lastError);
  $('liveDot').className = `dot ${errors.length ? '' : 'live'}`;
  $('liveStatus').textContent = errors.length ? `Kraken issue on ${[...new Set(errors.map(b=>b.symbol))].join(', ')}` : '15 paper bots live • 5 Kraken feeds • server 24/7';
}

async function refreshState(){ try{ state=await api('/api/state'); render(); }catch(e){ $('liveDot').className='dot'; $('liveStatus').textContent='Server connection lost'; console.error(e); } }
$('refreshBtn').addEventListener('click', async()=>{ $('refreshBtn').disabled=true; try{ state=await api('/api/refresh',{method:'POST',body:'{}'}); render(); } finally { $('refreshBtn').disabled=false; } });
refreshState(); setInterval(refreshState,5000);
