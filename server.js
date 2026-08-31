const http=require('http');
const fs=require('fs');
const path=require('path');
const PORT=process.env.PORT||3000;
const STATE_FILE=process.env.STATE_FILE||path.join(__dirname,'paper-state-70bots.json');
const STATE_DIR=path.dirname(STATE_FILE);
try{fs.mkdirSync(STATE_DIR,{recursive:true});}catch(e){console.error('State directory init failed:',e.message);}
const POLL_MS=Math.max(5000,Number(process.env.POLL_MS||15000));

const ASSETS={
  XAU:{label:'Gold / USD',source:'futures',pair:'PF_XAUUSD'},
  XAG:{label:'Silver / USD',source:'futures',pair:'PF_XAGUSD'},
  WTI:{label:'WTI Oil / USD',source:'futures',pair:'PF_WTIOILUSD'},
  PAXG:{label:'PAX Gold / USD',source:'spot',pair:'PAXGUSD'},
  BTC:{label:'Bitcoin / USD',source:'spot',pair:'XBTUSD'},
  SOL:{label:'Solana / USD',source:'spot',pair:'SOLUSD'},
  TRUMP:{label:'TRUMP / USD',source:'spot',pair:'TRUMPUSD'},
  ETH:{label:'Ethereum / USD',source:'spot',pair:'ETHUSD'},
  XRP:{label:'XRP / USD',source:'spot',pair:'XRPUSD'},
  DOGE:{label:'Dogecoin / USD',source:'spot',pair:'DOGEUSD'}
};
const TARGETS=[0.05,0.1,0.15,0.2,0.5,1,2];
const botId=(s,t)=>`${s}_${String(t).replace('.','_')}`;

function freshBot(symbol,targetPct){return {id:botId(symbol,targetPct),symbol,pair:ASSETS[symbol].pair,label:ASSETS[symbol].label,baseCapital:1000,targetPct,feePct:0,currentPrice:null,startPrice:null,entryPrice:null,tokensHeld:0,bankedProfit:0,harvestCount:0,running:true,lastUpdated:null,lastError:null,history:[]};}
function makeDefaults(){const bots={};for(const s of Object.keys(ASSETS))for(const t of TARGETS){const b=freshBot(s,t);bots[b.id]=b;}return {bots};}
function loadState(){try{if(fs.existsSync(STATE_FILE)){const saved=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));if(saved.bots){const bots={};for(const s of Object.keys(ASSETS))for(const t of TARGETS){const f=freshBot(s,t),p=saved.bots[f.id];if(p){const merged={...f,...p,id:f.id,symbol:s,pair:f.pair,label:f.label,targetPct:t,baseCapital:1000};if(!merged.startPrice){merged.startPrice=Number(merged.history?.[0]?.entry)||Number(merged.entryPrice)||Number(merged.currentPrice)||null;}bots[f.id]=merged;}else bots[f.id]=f;}return {bots};}}}catch(e){console.error('State load failed:',e.message);}return makeDefaults();}
let state=loadState();
function saveState(){try{fs.mkdirSync(STATE_DIR,{recursive:true});fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}catch(e){console.error('State save failed:',e.message);}}
function targetPrice(b){return b.entryPrice?b.entryPrice*(1+b.targetPct/100):null;}
function positionValue(b){return b.tokensHeld&&b.currentPrice?b.tokensHeld*b.currentPrice:0;}
function evaluate(b){if(!b.running||!b.currentPrice)return;if(!b.startPrice)b.startPrice=b.currentPrice;if(!b.entryPrice){b.entryPrice=b.currentPrice;b.tokensHeld=b.baseCapital/b.entryPrice;return;}const target=targetPrice(b);if(b.currentPrice+Number.EPSILON<target)return;const exitValue=positionValue(b);const grossProfit=exitValue-b.baseCapital;const fees=(b.baseCapital+exitValue)*(b.feePct/100);const netBanked=grossProfit-fees;b.bankedProfit+=netBanked;b.harvestCount++;b.history.push({number:b.harvestCount,time:new Date().toISOString(),entry:b.entryPrice,exit:b.currentPrice,grossProfit,fees,netBanked,totalBanked:b.bankedProfit});if(b.history.length>500)b.history=b.history.slice(-500);b.entryPrice=b.currentPrice;b.tokensHeld=b.baseCapital/b.entryPrice;}
async function fetchSpot(pair){const r=await fetch(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`,{headers:{'user-agent':'harvest-lab-70/1.0'}});if(!r.ok)throw new Error(`Kraken spot HTTP ${r.status}`);const d=await r.json();if(d.error?.length)throw new Error(d.error.join(', '));const ticker=Object.values(d.result||{})[0],p=Number(ticker?.c?.[0]);if(!Number.isFinite(p)||p<=0)throw new Error('Spot price missing');return p;}
async function fetchFuturesMap(){const r=await fetch('https://futures.kraken.com/derivatives/api/v3/tickers',{headers:{'user-agent':'harvest-lab-70/1.0'}});if(!r.ok)throw new Error(`Kraken futures HTTP ${r.status}`);const d=await r.json();const rows=d.tickers||[];const out={};for(const row of rows){const sym=String(row.symbol||'').toUpperCase();const p=Number(row.last||row.markPrice||row.indexPrice);if(sym&&Number.isFinite(p)&&p>0)out[sym]=p;}return out;}
async function fetchAll(){let fmap={};let ferr=null;try{fmap=await fetchFuturesMap();}catch(e){ferr=e;}await Promise.all(Object.keys(ASSETS).map(async s=>{try{const a=ASSETS[s];let price;if(a.source==='futures'){if(ferr)throw ferr;price=fmap[a.pair];if(!Number.isFinite(price)||price<=0)throw new Error(`${a.pair} price missing`);}else price=await fetchSpot(a.pair);for(const t of TARGETS){const b=state.bots[botId(s,t)];b.currentPrice=price;b.lastUpdated=new Date().toISOString();b.lastError=null;evaluate(b);}}catch(e){for(const t of TARGETS){const b=state.bots[botId(s,t)];b.lastError=e.message;b.lastUpdated=new Date().toISOString();}console.error(`${s} fetch failed:`,e.message);}}));saveState();}
function publicBot(b){const pos=positionValue(b),cycleMovePct=b.entryPrice&&b.currentPrice?((b.currentPrice/b.entryPrice)-1)*100:0,target=targetPrice(b),distancePct=target&&b.currentPrice?((target/b.currentPrice)-1)*100:null,totalWealth=(b.entryPrice?pos:b.baseCapital)+b.bankedProfit,netResult=totalWealth-b.baseCapital,holdValue=b.startPrice&&b.currentPrice?b.baseCapital*(b.currentPrice/b.startPrice):b.baseCapital,holdProfit=holdValue-b.baseCapital,strategyAdvantage=netResult-holdProfit,strategyWinner=strategyAdvantage>0.005?'BOT':strategyAdvantage<-0.005?'HOLD':'TIE';return {...b,targetPrice:target,positionValue:pos,unrealized:b.entryPrice?pos-b.baseCapital:0,cycleMovePct,distancePct,totalWealth,netResult,holdValue,holdProfit,strategyAdvantage,strategyWinner};}
function publicState(){return {assets:Object.keys(ASSETS),targets:TARGETS,botCount:Object.keys(state.bots).length,capitalPerBot:1000,totalBaseCapital:Object.keys(state.bots).length*1000,bots:Object.fromEntries(Object.entries(state.bots).map(([id,b])=>[id,publicBot(b)]))};}
function sendJson(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(body);}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname==='/api/health')return sendJson(res,200,{ok:true,botCount:Object.keys(state.bots).length,lastUpdated:Math.max(...Object.values(state.bots).map(b=>Date.parse(b.lastUpdated)||0)),stateFile:STATE_FILE});if(url.pathname==='/api/state'&&req.method==='GET')return sendJson(res,200,publicState());if(url.pathname==='/api/refresh'&&req.method==='POST'){await fetchAll();return sendJson(res,200,publicState());}let urlPath=url.pathname==='/'?'index.html':url.pathname.replace(/^[/\\]+/,'');const safePath=path.normalize(urlPath).replace(/^([.][.][/\\])+/,'');const filePath=path.join(__dirname,safePath);if(!filePath.startsWith(__dirname)){res.writeHead(403);return res.end('Forbidden');}fs.readFile(filePath,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'content-type':mime[path.extname(filePath)]||'application/octet-stream','cache-control':'no-store'});res.end(data);});}catch(e){console.error(e);sendJson(res,500,{error:e.message});}});
server.listen(PORT,()=>console.log(`70 Bot Harvest Lab listening on ${PORT} using state file ${STATE_FILE}`));
fetchAll();setInterval(fetchAll,POLL_MS);
