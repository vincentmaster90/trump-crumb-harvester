const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'paper-state.json');
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 15000));
const KRAKEN_PAIR = process.env.KRAKEN_PAIR || 'TRUMPUSD';

const defaults = {
  baseCapital: 1000,
  targetPct: 2,
  feePct: 0,
  currentPrice: null,
  entryPrice: null,
  tokensHeld: 0,
  bankedProfit: 0,
  harvestCount: 0,
  running: true,
  source: 'Kraken public ticker',
  pair: KRAKEN_PAIR,
  lastUpdated: null,
  lastError: null,
  history: []
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch (e) {
    console.error('State load failed:', e.message);
  }
  return { ...defaults };
}

let state = loadState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('State save failed:', e.message);
  }
}

function targetPrice() {
  return state.entryPrice ? state.entryPrice * (1 + state.targetPct / 100) : null;
}

function positionValue() {
  return state.tokensHeld && state.currentPrice ? state.tokensHeld * state.currentPrice : 0;
}

function evaluate() {
  if (!state.running || !state.currentPrice) return;

  if (!state.entryPrice) {
    state.entryPrice = state.currentPrice;
    state.tokensHeld = state.baseCapital / state.entryPrice;
    saveState();
    console.log(`Paper cycle started at $${state.entryPrice}`);
    return;
  }

  const target = targetPrice();
  if (state.currentPrice + Number.EPSILON < target) return;

  const exitValue = positionValue();
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

  console.log(`Harvest #${state.harvestCount}: banked $${netBanked.toFixed(2)} at $${state.currentPrice}`);

  state.entryPrice = state.currentPrice;
  state.tokensHeld = state.baseCapital / state.entryPrice;
  saveState();
}

async function fetchKrakenPrice() {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(KRAKEN_PAIR)}`;
    const res = await fetch(url, { headers: { 'user-agent': 'trump-crumb-harvester/1.0' } });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.error) && data.error.length) throw new Error(data.error.join(', '));
    const ticker = Object.values(data.result || {})[0];
    const price = Number(ticker?.c?.[0]);
    if (!Number.isFinite(price) || price <= 0) throw new Error('TRUMP/USD price missing');

    state.currentPrice = price;
    state.lastUpdated = new Date().toISOString();
    state.lastError = null;
    evaluate();
    saveState();
  } catch (e) {
    state.lastError = e.message;
    state.lastUpdated = new Date().toISOString();
    console.error('Price fetch failed:', e.message);
    saveState();
  }
}

function publicState() {
  const pos = positionValue();
  const cycleMovePct = state.entryPrice && state.currentPrice
    ? ((state.currentPrice / state.entryPrice) - 1) * 100
    : 0;
  const target = targetPrice();
  const distancePct = target && state.currentPrice
    ? ((target / state.currentPrice) - 1) * 100
    : null;
  return {
    ...state,
    targetPrice: target,
    positionValue: pos,
    unrealized: state.entryPrice ? pos - state.baseCapital : 0,
    cycleMovePct,
    distancePct,
    totalWealth: (state.entryPrice ? pos : state.baseCapital) + state.bankedProfit
  };
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
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJson(res, 200, { ok: true, running: state.running, lastUpdated: state.lastUpdated, lastError: state.lastError });
    if (req.url === '/api/state' && req.method === 'GET') return sendJson(res, 200, publicState());

    if (req.url === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (Number(body.baseCapital) > 0) state.baseCapital = Number(body.baseCapital);
      if (Number(body.targetPct) > 0) state.targetPct = Number(body.targetPct);
      if (Number(body.feePct) >= 0) state.feePct = Number(body.feePct);
      if (body.restart === true) {
        state.entryPrice = state.currentPrice;
        state.tokensHeld = state.currentPrice ? state.baseCapital / state.currentPrice : 0;
      }
      state.running = true;
      evaluate();
      saveState();
      return sendJson(res, 200, publicState());
    }

    if (req.url === '/api/pause' && req.method === 'POST') {
      state.running = false;
      saveState();
      return sendJson(res, 200, publicState());
    }

    if (req.url === '/api/reset' && req.method === 'POST') {
      const price = state.currentPrice;
      const updated = state.lastUpdated;
      state = { ...defaults, currentPrice: price, lastUpdated: updated, running: false };
      saveState();
      return sendJson(res, 200, publicState());
    }

    if (req.url === '/api/refresh' && req.method === 'POST') {
      await fetchKrakenPrice();
      return sendJson(res, 200, publicState());
    }

    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const safePath = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
    const filePath = path.join(__dirname, safePath);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403); return res.end('Forbidden');
    }
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

server.listen(PORT, () => console.log(`TRUMP Crumb Harvester listening on ${PORT}`));
fetchKrakenPrice();
setInterval(fetchKrakenPrice, POLL_MS);
