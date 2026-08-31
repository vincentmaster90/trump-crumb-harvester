const $ = (id) => document.getElementById(id);
let state = null;
const SYMBOLS = ['XMR','SOL','BTC','ETH','PAXG'];

function money(n) {
  return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:2 }).format(Number(n || 0));
}
function priceFmt(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n); return `$${v.toLocaleString('en-US',{minimumFractionDigits:v>=100?2:4,maximumFractionDigits:v>=100?2:6})}`;
}
function pct(n) { const v=Number(n||0); return `${v>=0?'+':''}${v.toFixed(2)}%`; }
async function api(path, options={}) {
  const res = await fetch(path,{cache:'no-store',headers:{'content-type':'application/json',...(options.headers||{})},...options});
  if(!res.ok) throw new Error(`HTTP ${res.status}`); return res.json();
}

function botCard(b) {
  const shownCapital = b.symbol === 'XMR' ? 80 : b.baseCapital;
  return `<article class="panel" id="card-${b.symbol}">
    <div class="panel-head"><div><p class="eyebrow">${b.label}</p><h2>${b.symbol} Bot</h2></div><span class="badge ${b.running?'on':'off'}">${b.running?'RUNNING':'PAUSED'}</span></div>
    <div class="grid stats lower">
      <article class="card accent"><span>Live price</span><strong>${priceFmt(b.currentPrice)}</strong><small>${b.lastError ? b.lastError : 'Kraken live'}</small></article>
      <article class="card"><span>Cycle entry</span><strong>${priceFmt(b.entryPrice)}</strong><small class="${b.cycleMovePct>0?'positive':b.cycleMovePct<0?'negative':''}">${pct(b.cycleMovePct)}</small></article>
      <article class="card"><span>Next harvest</span><strong>${priceFmt(b.targetPrice)}</strong><small>+${Number(b.targetPct).toFixed(2)}%</small></article>
      <article class="card profit"><span>Banked profit</span><strong>${money(b.bankedProfit)}</strong><small>${b.harvestCount} harvests</small></article>
    </div>
    <label>Base capital<div class="input-row"><span>$</span><input id="capital-${b.symbol}" type="number" min="1" step="1" value="${shownCapital}"></div></label>
    <label>Harvest target<div class="input-row"><input id="target-${b.symbol}" type="number" min="0.1" step="0.1" value="${b.targetPct}"><span>%</span></div></label>
    <div class="button-row"><button class="primary" onclick="startBot('${b.symbol}')">Start / Resume</button><button class="secondary" onclick="pauseBot('${b.symbol}')">Pause</button></div>
    <div class="formula"><strong>Current position</strong><p>${money(b.positionValue)} • Unrealized ${money(b.unrealized)} • Total wealth ${money(b.totalWealth)}</p></div>
  </article>`;
}

function renderTotals() {
  const bots = SYMBOLS.map(s => state.bots[s]);
  const totalCapital = bots.reduce((sum,b)=>sum + Number(b.symbol === 'XMR' ? 80 : (b.baseCapital || 0)),0);
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
  $('totalPnL').className = totalPnL > 0 ? 'positive' : totalPnL < 0 ? 'negative' : '';
}

function render() {
  if(!state?.bots) return;
  renderTotals();
  $('botsGrid').innerHTML = SYMBOLS.map(s=>botCard(state.bots[s])).join('');
  $('scoreBody').innerHTML = SYMBOLS.map(s=>{ const b=state.bots[s]; const capital=s==='XMR'?80:b.baseCapital; return `<tr><td><strong>${s}</strong></td><td>${priceFmt(b.currentPrice)}</td><td>${money(capital)}</td><td>${Number(b.targetPct).toFixed(2)}%</td><td class="${b.cycleMovePct>0?'positive':b.cycleMovePct<0?'negative':''}">${pct(b.cycleMovePct)}</td><td>${b.harvestCount}</td><td class="positive">${money(b.bankedProfit)}</td><td>${money(b.totalWealth)}</td></tr>`; }).join('');
  const errors = SYMBOLS.filter(s=>state.bots[s].lastError);
  $('liveDot').className = `dot ${errors.length ? '' : 'live'}`;
  $('liveStatus').textContent = errors.length ? `Kraken issue: ${errors.join(', ')}` : '5 Kraken feeds live • server 24/7';
}

async function refreshState(){ try{ state=await api('/api/state'); render(); }catch(e){ $('liveDot').className='dot'; $('liveStatus').textContent='Server connection lost'; console.error(e); } }

async function startBot(symbol){
  const fallbackCapital = symbol === 'XMR' ? 80 : 1000;
  const baseCapital=Number($(`capital-${symbol}`).value||fallbackCapital);
  const targetPct=Number($(`target-${symbol}`).value||2);
  state=await api('/api/bot',{method:'POST',body:JSON.stringify({symbol,action:'start',baseCapital,targetPct,feePct:0,restart:false})}); render();
}
async function pauseBot(symbol){ state=await api('/api/bot',{method:'POST',body:JSON.stringify({symbol,action:'pause'})}); render(); }
window.startBot=startBot; window.pauseBot=pauseBot;

$('refreshBtn').addEventListener('click', async()=>{ $('refreshBtn').disabled=true; try{ state=await api('/api/refresh',{method:'POST',body:'{}'}); render(); } finally { $('refreshBtn').disabled=false; } });
refreshState(); setInterval(refreshState,5000);
