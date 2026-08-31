const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'paper-state.json');
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 15000));

const ASSETS = {
  XMR: { pair: 'XMRUSD', label: 'XMR / USD' },
  SOL: { pair: 'SOLUSD', label: 'SOL / USD' },
  BTC: { pair: 'XBTUSD', label: 'BTC / USD' },
  ETH: { pair: 'ETHUSD', label: 'ETH / USD' },
  PAXG: { pair: 'PAXGUSD', label: 'PAXG / USD' }
};

function freshBot(symbol) {
  return {
    symbol,
    pair: ASSETS[symbol].pair,
    label: ASSETS[symbol].label,
    baseCapital: 1000,
    targetPct: 2,
    feePct: 0,
    currentPrice: null,
    entryPrice: null,
    tokensHeld: 0,
    bankedProfit: 0,
    harvestCount: 0,
    running: false,
    lastUpdated: null,
    lastError: null,
    history: []
  };
}

const defaults = { bots: Object.fromEntries(Object.keys(ASSETS).map(s => [s, freshBot(s)])) };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.bots) {
        const bots = {};
        for (const s of Object.keys(ASSETS)) bots[s] = { ...freshBot(s), ...(saved.bots[s] || {}) };
        return { bots };
      }
    }
  } catch (e) {
    console.error('State load failed:', e.message);
  }
  return JSON.parse(JSON.stringify(defaults));
}

let state = loadState();

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('State save failed:', e.message); }
}

function targetPrice(bot) {
  return bot.entryPrice ? bot.entryPrice * (1 + bot.targetPct / 100) : null;
}

function positionValue(bot) {
  return bot.tokensHeld && bot.currentPrice ? bot.tokensHeld * bot.currentPrice : 0;
}

function evaluate(bot) {
  if (!bot.running || !bot.currentPrice) return;
  if (!bot.entryPrice) {
    bot.entryPrice = bot.currentPrice;
    bot.tokensHeld = bot.baseCapital / bot.entryPrice;
    console.log(`${bot.symbol} paper cycle started at $${bot.entryPrice}`);
    return;
  }
  const target = targetPrice(bot);
  if (bot.currentPrice + Number.EPSILON < target) return;

  const exitValue = positionValue(bot);
  const grossProfit = exitValue - bot.baseCapital;
  const fees = (bot.baseCapital + exitValue) * (bot.feePct / 100);
  const netBanked = grossProfit - fees;
  bot.bankedProfit += netBanked;
  bot.harvestCount += 1;
  bot.history.push({
    number: bot.harvestCount,
    time: new Date().toISOString(),
    entry: bot.entryPrice,
    exit: bot.currentPrice,
    grossProfit,
    fees,
    netBanked,
    totalBanked: bot.bankedProfit
  });
  console.log(`${bot.symbol} harvest #${bot.harvestCount}: $${netBanked.toFixed(2)}`);
  bot.entryPrice = bot.currentPrice;
  bot.tokensHeld = bot.baseCapital / bot.entryPrice;
}

async function fetchPrice(bot) {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(bot.pair)}`;
    const res = await fetch(url, { headers: { 'user-agent': 'crumb-harvester/2.0' } });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.error) && data.error.length) throw new Error(data.error.join(', '));
    const ticker = Object.values(data.result || {})[0];
    const price = Number(ticker?.c?.[0]);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`${bot.symbol}/USD price missing`);
    bot.currentPrice = price;
    bot.lastUpdated = new Date().toISOString();
    bot.lastError = null;
    evaluate(bot);
  } catch (e) {
    bot.lastError = e.message;
    bot.lastUpdated = new Date().toISOString();
    console.error(`${bot.symbol} price fetch failed:`, e.message);
  }
}

async function fetchAll() {
  await Promise.all(Object.values(state.bots).map(fetchPrice));
  saveState();
}

function publicBot(bot) {
  const pos = positionValue(bot);
  const cycleMovePct = bot.entryPrice && bot.currentPrice ? ((bot.currentPrice / bot.entryPrice) - 1) * 100 : 0;
  const target = targetPrice(bot);
  const distancePct = target && bot.currentPrice ? ((target / bot.currentPrice) - 1) * 100 : null;
  return {
    ...bot,
    targetPrice: target,
    positionValue: pos,
    unrealized: bot.entryPrice ? pos - bot.baseCapital : 0,
    cycleMovePct,
    distancePct,
    totalWealth: (bot.entryPrice ? pos : bot.baseCapital) + bot.bankedProfit
  };
}

function publicState() {
  return { bots: Object.fromEntries(Object.entries(state.bots).map(([s,b]) => [s, publicBot(b)])) };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, bots: Object.values(state.bots).map(b => ({ symbol:b.symbol, running:b.running, lastUpdated:b.lastUpdated, lastError:b.lastError })) });
    if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, publicState());

    if (url.pathname === '/api/bot' && req.method === 'POST') {
      const body = await readBody(req);
      const symbol = String(body.symbol || '').toUpperCase();
      const bot = state.bots[symbol];
      if (!bot) return sendJson(res, 400, { error: 'Unknown symbol' });
      if (Number(body.baseCapital) > 0) bot.baseCapital = Number(body.baseCapital);
      if (Number(body.targetPct) > 0) bot.targetPct = Number(body.targetPct);
      if (Number(body.feePct) >= 0) bot.feePct = Number(body.feePct);
      if (body.action === 'start') {
        if (!bot.running || body.restart === true || !bot.entryPrice) {
          bot.entryPrice = bot.currentPrice;
          bot.tokensHeld = bot.currentPrice ? bot.baseCapital / bot.currentPrice : 0;
        }
        bot.running = true;
        evaluate(bot);
      } else if (body.action === 'pause') bot.running = false;
      else if (body.action === 'reset') {
        const price = bot.currentPrice, updated = bot.lastUpdated;
        state.bots[symbol] = { ...freshBot(symbol), currentPrice: price, lastUpdated: updated };
      }
      saveState();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      await fetchAll();
      return sendJson(res, 200, publicState());
    }

    let urlPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^[/\\]+/, '');
    const safePath = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
    const filePath = path.join(__dirname, safePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Multi Crumb Harvester listening on ${PORT}`));
fetchAll();
setInterval(fetchAll, POLL_MS);
