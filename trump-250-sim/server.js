const http=require('http'),fs=require('fs'),path=require('path');
const PORT=Number(process.env.PORT||3000);
const SYMBOL='TRUMPUSDT';
const CAPITAL=Number(process.env.CAPITAL_USDT||250);
const TARGET_PCT=Number(process.env.TARGET_PCT||0.5);
const FEE_PCT=Number(process.env.SPOT_FEE_PCT||0.1);
const MIN_ORDER_USDT=Number(process.env.MIN_ORDER_USDT||1.02);
const POLL_MS=Math.max(5000,Number(process.env.POLL_MS||10000));
const STATE_FILE=process.env.STATE_FILE||path.join(__dirname,'state.json');
const BASE_URL='https://api.bybit.com';
function round(x,n=6){return Number(Number(x).toFixed(n));}
function fresh(){return{mode:'SIMULATOR',symbol:SYMBOL,capitalUsdt:CAPITAL,targetPct:TARGET_PCT,feePct:FEE_PCT,minOrderUsdt:MIN_ORDER_USDT,startedAt:null,lastUpdated:null,lastPrice:null,anchorPrice:null,tokensHeld:0,harvestCount:0,grossHarvestedUsdt:0,feesPaidUsdt:0,netHarvestedUsdt:0,lastHarvest:null,history:[],lastError:null};}
function load(){try{if(fs.existsSync(STATE_FILE))return{...fresh(),...JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))};}catch{}return fresh();}
let state=load();
function save(){try{fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}catch(e){}}
async function publicGet(route,params={}){const q=new URLSearchParams(params).toString();const r=await fetch(`${BASE_URL}${route}?${q}`);const j=await r.json();if(!r.ok||j.retCode!==0)throw new Error(j.retMsg||`HTTP ${r.status}`);return j.result;}
async function fetchMarket(){const [t,inst]=await Promise.all([publicGet('/v5/market/tickers',{category:'spot',symbol:SYMBOL}),publicGet('/v5/market/instruments-info',{category:'spot',symbol:SYMBOL})]);const price=Number(t.list?.[0]?.lastPrice);if(!Number.isFinite(price)||price<=0)throw new Error('TRUMP price unavailable');const minOrderAmt=Number(inst.list?.[0]?.lotSizeFilter?.minOrderAmt||MIN_ORDER_USDT);return{price,minOrderAmt};}
function positionValue(){return state.tokensHeld*state.lastPrice;}
function initialize(price){state.startedAt=new Date().toISOString();state.lastPrice=price;state.anchorPrice=price;state.tokensHeld=CAPITAL/price;state.lastUpdated=state.startedAt;}
function evaluate(price,minOrderAmt){state.lastPrice=price;state.minOrderUsdt=Math.max(MIN_ORDER_USDT,minOrderAmt||0);state.lastUpdated=new Date().toISOString();if(!state.anchorPrice){initialize(price);return;}const trigger=state.anchorPrice*(1+TARGET_PCT/100);const value=positionValue();const grossExcess=Math.max(0,value-CAPITAL);if(price+Number.EPSILON>=trigger&&grossExcess+1e-12>=state.minOrderUsdt){const fee=grossExcess*(FEE_PCT/100);const net=grossExcess-fee;const soldTokens=grossExcess/price;state.tokensHeld=Math.max(0,state.tokensHeld-soldTokens);state.harvestCount++;state.grossHarvestedUsdt+=grossExcess;state.feesPaidUsdt+=fee;state.netHarvestedUsdt+=net;state.lastHarvest={number:state.harvestCount,time:state.lastUpdated,price:round(price,8),gross:round(grossExcess,6),fee:round(fee,6),net:round(net,6)};state.history.push(state.lastHarvest);state.anchorPrice=price;}}
async function tick(){try{const m=await fetchMarket();if(!state.startedAt)initialize(m.price);else evaluate(m.price,m.minOrderAmt);state.lastError=null;}catch(e){state.lastError=e.message;state.lastUpdated=new Date().toISOString();}save();}
function view(){const value=state.lastPrice?positionValue():CAPITAL;const unrealized=value-CAPITAL;const nextTarget=state.anchorPrice?state.anchorPrice*(1+TARGET_PCT/100):null;const elapsedHours=state.startedAt?Math.max(0,(Date.now()-new Date(state.startedAt).getTime())/36e5):0;return{...state,positionValueUsdt:round(value,6),unrealizedUsdt:round(unrealized,6),nextTargetPrice:nextTarget?round(nextTarget,8):null,distanceToTargetPct:state.lastPrice&&nextTarget?round(((nextTarget/state.lastPrice)-1)*100,4):null,totalEconomicValueUsdt:round(value+state.netHarvestedUsdt,6),elapsedHours:round(elapsedHours,3),harvestsPerHour:elapsedHours?round(state.harvestCount/elapsedHours,3):0,netPerHourUsdt:elapsedHours?round(state.netHarvestedUsdt/elapsedHours,4):0};}
function send(res,code,obj,type='application/json; charset=utf-8'){const body=type.startsWith('application/json')?JSON.stringify(obj):obj;res.writeHead(code,{'content-type':type,'cache-control':'no-store'});res.end(body);}
const server=http.createServer((req,res)=>{const u=new URL(req.url,`http://${req.headers.host}`);if(u.pathname==='/api/state')return send(res,200,view());if(u.pathname==='/api/health')return send(res,200,{ok:!state.lastError,mode:'SIMULATOR',lastError:state.lastError});if(u.pathname==='/api/reset'&&req.method==='POST'){state=fresh();save();tick();return send(res,200,{ok:true});}if(u.pathname==='/')return fs.readFile(path.join(__dirname,'index.html'),'utf8',(e,d)=>e?send(res,500,'Error','text/plain'):send(res,200,d,'text/html; charset=utf-8'));return send(res,404,{error:'Not found'});});
server.listen(PORT,()=>console.log(`TRUMP $250 simulator on ${PORT}`));tick();setInterval(tick,POLL_MS);
