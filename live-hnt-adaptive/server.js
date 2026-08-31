const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const PORT=Number(process.env.PORT||3000);
const API_KEY=process.env.KRAKEN_API_KEY||'';
const API_SECRET=process.env.KRAKEN_API_SECRET||'';
const PAIR=process.env.KRAKEN_PAIR||'HNTUSD';
const TOTAL_CAPITAL_USD=Number(process.env.TOTAL_CAPITAL_USD||80);
const CORE_USD=Number(process.env.CORE_USD||40);
const RESERVE_USD=Number(process.env.RESERVE_USD||40);
const TRANCHE_USD=Number(process.env.TRANCHE_USD||20);
const DIP_STEP_PCT=Number(process.env.DIP_STEP_PCT||2);
const REBOUND_TARGET_PCT=Number(process.env.REBOUND_TARGET_PCT||2);
const POLL_MS=Math.max(10000,Number(process.env.POLL_MS||15000));
const LIVE_TRADING=String(process.env.LIVE_TRADING||'false').toLowerCase()==='true';
const STATE_FILE=process.env.STATE_FILE||'/data/hnt-adaptive-state.json';
const MIN_QUOTE_USD=Number(process.env.MIN_QUOTE_USD||0.50);

function fresh(){return{version:1,pair:PAIR,totalCapitalUsd:TOTAL_CAPITAL_USD,coreUsd:CORE_USD,reserveUsd:RESERVE_USD,trancheUsd:TRANCHE_USD,dipStepPct:DIP_STEP_PCT,reboundTargetPct:REBOUND_TARGET_PCT,status:'SETUP_REQUIRED',anchorPrice:null,lastBuyLevel:null,core:{entryPrice:null,volume:0},tranches:[],realizedProfitUsd:0,cycleCount:0,lastPrice:null,lastUpdated:null,lastOrder:null,lastError:null,armed:LIVE_TRADING};}
function load(){try{if(fs.existsSync(STATE_FILE))return{...fresh(),...JSON.parse(fs.readFileSync(STATE_FILE,'utf8')),armed:LIVE_TRADING};}catch{}return fresh();}
let state=load();
function save(){fs.mkdirSync(path.dirname(STATE_FILE),{recursive:true});fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}
function nonce(){return String(Date.now()*1000+Math.floor(Math.random()*1000));}
async function publicCall(method,params={}){const q=new URLSearchParams(params).toString();const r=await fetch(`https://api.kraken.com/0/public/${method}${q?'?'+q:''}`);const j=await r.json();if(!r.ok||j.error?.length)throw new Error(j.error?.join(', ')||`HTTP ${r.status}`);return j.result;}
async function privateCall(method,params={}){if(!API_KEY||!API_SECRET)throw new Error('Kraken API credentials missing');const n=nonce(),body=new URLSearchParams({nonce:n,...params}).toString(),urlPath=`/0/private/${method}`;const hash=crypto.createHash('sha256').update(n+body).digest();const sig=crypto.createHmac('sha512',Buffer.from(API_SECRET,'base64')).update(Buffer.concat([Buffer.from(urlPath),hash])).digest('base64');const r=await fetch(`https://api.kraken.com${urlPath}`,{method:'POST',headers:{'API-Key':API_KEY,'API-Sign':sig,'Content-Type':'application/x-www-form-urlencoded'},body});const j=await r.json();if(!r.ok||j.error?.length)throw new Error(j.error?.join(', ')||`HTTP ${r.status}`);return j.result;}
async function pairInfo(){const result=await publicCall('AssetPairs',{pair:PAIR});const v=Object.values(result)[0];if(!v)throw new Error('Pair info missing');return{ordermin:Number(v.ordermin||0),lotDecimals:Number(v.lot_decimals||8)};}
async function ticker(){const result=await publicCall('Ticker',{pair:PAIR});const v=Object.values(result)[0];const p=Number(v?.c?.[0]);if(!p)throw new Error('Price missing');return p;}
const floor=(x,d)=>Math.floor(x*10**d)/10**d;
async function addOrder(type,volume){if(!LIVE_TRADING)throw new Error('LIVE_TRADING is false');return privateCall('AddOrder',{ordertype:'market',type,pair:PAIR,volume:String(volume)});}
async function queryOrder(txid){const r=await privateCall('QueryOrders',{txid});return r?.[txid]||Object.values(r||{})[0]||null;}
async function waitClosed(txid,timeoutMs=60000){const end=Date.now()+timeoutMs;while(Date.now()<end){const o=await queryOrder(txid);if(o&&['closed','canceled','expired'].includes(o.status))return o;await new Promise(r=>setTimeout(r,2500));}return queryOrder(txid);}
async function market(type,usd,info,price){const volume=floor(usd/price,info.lotDecimals);if(volume<info.ordermin)throw new Error(`Volume ${volume} below ordermin ${info.ordermin}`);if(volume*price<MIN_QUOTE_USD)throw new Error(`Order notional below $${MIN_QUOTE_USD}`);const add=await addOrder(type,volume),txid=add?.txid?.[0];if(!txid)throw new Error('Order txid missing');const o=await waitClosed(txid);if(!o||o.status!=='closed')throw new Error(`Order not closed (${o?.status||'unknown'})`);return{txid,filled:Number(o.vol_exec||0),cost:Number(o.cost||0),fee:Number(o.fee||0),price:Number(o.cost||0)/Number(o.vol_exec||1)};}
function reserveAvailable(){const committed=state.tranches.filter(t=>t.open).reduce((s,t)=>s+t.usd,s,0);return Math.max(0,state.reserveUsd-committed);}
async function evaluate(info,price){state.lastPrice=price;state.lastUpdated=new Date().toISOString();state.armed=LIVE_TRADING;
if(!state.anchorPrice){state.status='SETUP_REQUIRED';save();return;}
for(const t of state.tranches.filter(t=>t.open)){const target=t.entryPrice*(1+state.reboundTargetPct/100);if(price>=target){if(!LIVE_TRADING){state.status='TARGET_HIT_NOT_ARMED';continue;}const volume=Math.min(t.volume,floor(t.volume,info.lotDecimals));const notional=volume*price;if(volume<info.ordermin||notional<MIN_QUOTE_USD){state.status='TARGET_HIT_PENDING_MINIMUM';continue;}const add=await addOrder('sell',volume),txid=add?.txid?.[0];const o=await waitClosed(txid);if(!o||o.status!=='closed')throw new Error(`Sell order not closed (${o?.status||'unknown'})`);const cost=Number(o.cost||0),fee=Number(o.fee||0);t.open=false;t.exitPrice=cost/Number(o.vol_exec||1);t.exitTime=new Date().toISOString();t.netProceeds=cost-fee;t.profitUsd=(cost-fee)-t.costWithFee;state.realizedProfitUsd+=t.profitUsd;state.cycleCount++;state.lastOrder={side:'sell-rebound',txid,cost,fee,profitUsd:t.profitUsd,time:t.exitTime};save();}}
const levelBase=state.lastBuyLevel||state.anchorPrice;const trigger=levelBase*(1-state.dipStepPct/100);if(price<=trigger&&reserveAvailable()>=state.trancheUsd){if(!LIVE_TRADING){state.status='DIP_HIT_NOT_ARMED';return;}const o=await market('buy',state.trancheUsd,info,price);state.tranches.push({id:Date.now(),open:true,usd:state.trancheUsd,entryPrice:o.price,volume:o.filled,costWithFee:o.cost+o.fee,entryTime:new Date().toISOString()});state.lastBuyLevel=o.price;state.lastOrder={side:'buy-dip',...o,time:new Date().toISOString()};state.status='RUNNING';save();return;}
state.status='RUNNING';}
async function tick(){try{const [info,price]=await Promise.all([pairInfo(),ticker()]);await evaluate(info,price);state.lastError=null;save();}catch(e){state.lastError=e.message;state.status='ERROR';save();console.error(e.message);}}
function view(){return{...state,reserveAvailableUsd:reserveAvailable(),openTranches:state.tranches.filter(t=>t.open).length,credentialsConfigured:Boolean(API_KEY&&API_SECRET),liveTrading:LIVE_TRADING};}
function send(res,code,obj,type='application/json; charset=utf-8'){const body=type.startsWith('application/json')?JSON.stringify(obj):obj;res.writeHead(code,{'content-type':type,'cache-control':'no-store'});res.end(body);}
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,`http://${req.headers.host}`);if(u.pathname==='/api/state')return send(res,200,view());if(u.pathname==='/api/health')return send(res,200,{ok:true,status:state.status,lastError:state.lastError});if(u.pathname==='/api/kraken-check'){try{await privateCall('Balance');return send(res,200,{connected:true,authenticated:true,readOnlyCheck:true,liveTrading:LIVE_TRADING});}catch(e){return send(res,200,{connected:false,authenticated:false,readOnlyCheck:true,liveTrading:LIVE_TRADING,error:e.message});}}if(u.pathname==='/'){return fs.readFile(path.join(__dirname,'index.html'),'utf8',(e,d)=>e?send(res,500,'Error','text/plain'):send(res,200,d,'text/html; charset=utf-8'));}send(res,404,{error:'Not found'});});
server.listen(PORT,()=>console.log(`HNT adaptive bot listening on ${PORT}; pair=${PAIR}; live=${LIVE_TRADING}`));
tick();setInterval(tick,POLL_MS);
