const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const PORT=Number(process.env.PORT||3000);
const API_KEY=process.env.BYBIT_API_KEY||'';
const API_SECRET=process.env.BYBIT_API_SECRET||'';
const BASE_URL=process.env.BYBIT_BASE_URL||'https://api.bybit.com';
const SYMBOL=process.env.BYBIT_SYMBOL||'TRUMPUSDT';
const CAPITAL=Number(process.env.CAPITAL_USDT||60);
const FEE_PCT=Number(process.env.SPOT_FEE_PCT||0.10);
const TARGETS=(process.env.TARGETS_PCT||'0.1,0.2,0.5,1,2,5').split(',').map(Number).filter(Number.isFinite);
const LIVE_TARGETS=(process.env.LIVE_TARGETS_PCT||'0.5,1,2').split(',').map(Number).filter(Number.isFinite);
const MIN_ORDER_USDT=Number(process.env.MIN_ORDER_USDT||1.02);
const ORDER_USDT=Number(process.env.ORDER_USDT||5);
const DIP_TRIGGER_PCT=Number(process.env.DIP_TRIGGER_PCT||1);
const POLL_MS=Math.max(5000,Number(process.env.POLL_MS||10000));
const LIVE_TRADING=String(process.env.LIVE_TRADING||'false').toLowerCase()==='true';
const STATE_FILE=process.env.STATE_FILE||'/data/bybit-trump-state.json';
const RECV_WINDOW='5000';

const round=(x,n=6)=>Number(Number(x).toFixed(n));
function netPct(target){const f=FEE_PCT/100;return ((1+target/100)*(1-f)*(1-f)-1)*100;}
function breakEvenPct(){const f=FEE_PCT/100;return (1/((1-f)*(1-f))-1)*100;}
function fresh(){return{version:1,symbol:SYMBOL,capitalUsdt:CAPITAL,feePct:FEE_PCT,minOrderUsdt:MIN_ORDER_USDT,orderUsdt:Math.max(ORDER_USDT,MIN_ORDER_USDT),targets:TARGETS.map(t=>({targetPct:t,netPct:round(netPct(t),4),liveEligible:LIVE_TARGETS.includes(t)&&netPct(t)>0})),status:'MONITORING',anchorPrice:null,lastPrice:null,bid:null,ask:null,spreadPct:null,openPositions:[],realizedProfitUsdt:0,cycles:0,lastOrder:null,lastError:null,lastUpdated:null,liveTrading:LIVE_TRADING};}
function load(){try{if(fs.existsSync(STATE_FILE))return{...fresh(),...JSON.parse(fs.readFileSync(STATE_FILE,'utf8')),liveTrading:LIVE_TRADING};}catch{}return fresh();}
let state=load();
function save(){fs.mkdirSync(path.dirname(STATE_FILE),{recursive:true});fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}
async function publicGet(route,params={}){const q=new URLSearchParams(params).toString();const r=await fetch(`${BASE_URL}${route}?${q}`);const j=await r.json();if(!r.ok||j.retCode!==0)throw new Error(j.retMsg||`HTTP ${r.status}`);return j.result;}
function sign(payload,ts){return crypto.createHmac('sha256',API_SECRET).update(ts+API_KEY+RECV_WINDOW+payload).digest('hex');}
async function privateReq(method,route,params={}){if(!API_KEY||!API_SECRET)throw new Error('Bybit API credentials missing');const ts=String(Date.now());let payload='',url=`${BASE_URL}${route}`,body;
if(method==='GET'){payload=new URLSearchParams(params).toString();if(payload)url+='?'+payload;}else{payload=JSON.stringify(params);body=payload;}
const r=await fetch(url,{method,headers:{'X-BAPI-API-KEY':API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':RECV_WINDOW,'X-BAPI-SIGN':sign(payload,ts),'Content-Type':'application/json'},body});const j=await r.json();if(!r.ok||j.retCode!==0)throw new Error(j.retMsg||`HTTP ${r.status}`);return j.result;}
async function marketData(){const [t,book,inst]=await Promise.all([publicGet('/v5/market/tickers',{category:'spot',symbol:SYMBOL}),publicGet('/v5/market/orderbook',{category:'spot',symbol:SYMBOL,limit:'1'}),publicGet('/v5/market/instruments-info',{category:'spot',symbol:SYMBOL})]);const row=t.list?.[0]||{},bid=Number(book.b?.[0]?.[0]||row.bid1Price),ask=Number(book.a?.[0]?.[0]||row.ask1Price),price=Number(row.lastPrice);const spreadPct=bid&&ask?((ask-bid)/((ask+bid)/2))*100:null;const lot=inst.list?.[0]?.lotSizeFilter||{};return{price,bid,ask,spreadPct,minOrderAmt:Number(lot.minOrderAmt||MIN_ORDER_USDT),basePrecision:lot.basePrecision||null,quotePrecision:lot.quotePrecision||null};}
async function createMarket(side,qty,marketUnit){if(!LIVE_TRADING)throw new Error('LIVE_TRADING is false');return privateReq('POST','/v5/order/create',{category:'spot',symbol:SYMBOL,side,orderType:'Market',qty:String(qty),marketUnit,timeInForce:'IOC'});}
async function orderInfo(orderId){const r=await privateReq('GET','/v5/order/realtime',{category:'spot',symbol:SYMBOL,orderId});return r.list?.[0]||null;}
async function waitFill(orderId){const end=Date.now()+30000;while(Date.now()<end){const o=await orderInfo(orderId);if(o&&['Filled','Cancelled','Rejected'].includes(o.orderStatus))return o;await new Promise(r=>setTimeout(r,1000));}return orderInfo(orderId);}
async function buy(usdt,targetPct){const r=await createMarket('Buy',Math.max(usdt,MIN_ORDER_USDT),'quoteCoin'),id=r.orderId;if(!id)throw new Error('Missing orderId');const o=await waitFill(id);if(!o||o.orderStatus!=='Filled')throw new Error(`Buy not filled (${o?.orderStatus||'unknown'})`);const qty=Number(o.cumExecQty||0),value=Number(o.cumExecValue||0),fee=Number(o.cumExecFee||0),entry=value/Math.max(qty,1e-12);return{id,qty,value,fee,entry,targetPct};}
async function sell(pos){const r=await createMarket('Sell',pos.qty,'baseCoin'),id=r.orderId;if(!id)throw new Error('Missing orderId');const o=await waitFill(id);if(!o||o.orderStatus!=='Filled')throw new Error(`Sell not filled (${o?.orderStatus||'unknown'})`);const value=Number(o.cumExecValue||0),fee=Number(o.cumExecFee||0);return{id,value,fee};}
function activeTarget(t){return LIVE_TARGETS.includes(t)&&netPct(t)>0;}
async function evaluate(md){state.lastPrice=md.price;state.bid=md.bid;state.ask=md.ask;state.spreadPct=md.spreadPct==null?null:round(md.spreadPct,4);state.minOrderUsdt=Math.max(MIN_ORDER_USDT,md.minOrderAmt||0);state.lastUpdated=new Date().toISOString();
if(!state.anchorPrice)state.anchorPrice=md.price;
for(const p of state.openPositions.filter(x=>x.open)){const trigger=p.entry*(1+p.targetPct/100);if(md.bid>=trigger){if(!LIVE_TRADING){state.status='TARGET_HIT_NOT_ARMED';continue;}const s=await sell(p);p.open=false;p.exitValue=s.value;p.exitFee=s.fee;p.exitTime=new Date().toISOString();p.profitUsdt=s.value-s.fee-p.costUsdt;p.netPct=round((p.profitUsdt/p.costUsdt)*100,4);state.realizedProfitUsdt+=p.profitUsdt;state.cycles++;state.lastOrder={side:'SELL',targetPct:p.targetPct,profitUsdt:p.profitUsdt,orderId:s.id,time:p.exitTime};save();}}
const drop=((state.anchorPrice-md.price)/state.anchorPrice)*100;if(drop>=DIP_TRIGGER_PCT&&state.openPositions.filter(x=>x.open).length===0){const viable=TARGETS.filter(activeTarget);if(viable.length&&LIVE_TRADING){const each=Math.max(state.minOrderUsdt,Math.min(ORDER_USDT,CAPITAL/viable.length));for(const t of viable){const b=await buy(each,t);state.openPositions.push({id:Date.now()+Math.random(),open:true,targetPct:t,entry:b.entry,qty:b.qty,costUsdt:b.value+b.fee,entryFee:b.fee,entryTime:new Date().toISOString()});}state.lastOrder={side:'BUY',targets:viable,time:new Date().toISOString()};state.anchorPrice=md.price;}else if(viable.length){state.status='DIP_HIT_NOT_ARMED';}}
if(md.price>state.anchorPrice)state.anchorPrice=md.price;
if(!state.status.includes('NOT_ARMED'))state.status='MONITORING';save();}
async function tick(){try{const md=await marketData();await evaluate(md);state.lastError=null;}catch(e){state.lastError=e.message;state.status='ERROR';}save();}
function view(){const grossTable=TARGETS.map(t=>({targetPct:t,grossProfitPer1000:round(1000*t/100,2),estimatedNetPct:round(netPct(t),4),estimatedNetPer1000:round(1000*netPct(t)/100,2),liveEligible:activeTarget(t)}));return{...state,breakEvenPct:round(breakEvenPct(),4),grossTable,credentialsConfigured:Boolean(API_KEY&&API_SECRET)};}
function send(res,code,obj,type='application/json; charset=utf-8'){const body=type.startsWith('application/json')?JSON.stringify(obj):obj;res.writeHead(code,{'content-type':type,'cache-control':'no-store'});res.end(body);}
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,`http://${req.headers.host}`);if(u.pathname==='/api/state')return send(res,200,view());if(u.pathname==='/api/health')return send(res,200,{ok:!state.lastError,status:state.status,lastError:state.lastError});if(u.pathname==='/api/bybit-check'){try{const r=await privateReq('GET','/v5/account/wallet-balance',{accountType:'UNIFIED'});return send(res,200,{connected:true,authenticated:true,liveTrading:LIVE_TRADING,coins:r.list?.[0]?.coin?.length||0});}catch(e){return send(res,200,{connected:false,authenticated:false,liveTrading:LIVE_TRADING,error:e.message});}}if(u.pathname==='/')return fs.readFile(path.join(__dirname,'index.html'),'utf8',(e,d)=>e?send(res,500,'Error','text/plain'):send(res,200,d,'text/html; charset=utf-8'));return send(res,404,{error:'Not found'});});
server.listen(PORT,()=>console.log(`Bybit TRUMP bot on ${PORT}; live=${LIVE_TRADING}`));tick();setInterval(tick,POLL_MS);
