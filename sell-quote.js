(function(root){
'use strict';
var USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',USDC_DECIMALS=6,FRESH_MS=30000,SLIPPAGE_BPS=100;
var config=root.NightshiftConfig||{};
var BASE=typeof config.quoteBase==='string'&&config.quoteBase?config.quoteBase.replace(/\/+$/,''):'https://api.jup.ag/swap/v2';
// Converts a decimal token amount to integer base units without floating-point drift on the fractional digits.
function toBaseUnits(amount,decimals){
  if(!Number.isFinite(amount)||amount<=0||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  var whole=Math.floor(amount),frac=amount-whole,scale=Math.pow(10,Math.min(decimals,6));
  var units=BigInt(whole)*(10n**BigInt(decimals))+(BigInt(Math.floor(frac*scale))*(10n**BigInt(decimals)))/BigInt(scale);
  return units>0n?units:null;
}
function numeric(v){return typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):null}
function base(status,reason,ctx,extra){return Object.assign({status:status,reason:reason,quotedAt:ctx.now,amountIn:ctx.amount.toString(),slippageBps:null,sellUsd:ctx.sellUsd,markUsd:ctx.markUsd,outUsd:null,minOutUsd:null,priceImpactPct:null,feeBps:null,platformFeeBps:null,router:null,route:[],shortfallPct:null},extra||{})}
// Normalises an order response without inventing fields: anything the API does not report stays null and is shown as "not reported".
function parseOrder(json,ctx){
  if(!json||typeof json!=='object')return base('UNVERIFIED','Quote response was not an object.',ctx);
  if(json.inputMint&&json.inputMint!==ctx.inputMint||json.outputMint&&json.outputMint!==ctx.outputMint)return base('UNVERIFIED','Quote response mints differ from the request.',ctx);
  var inAmount=numeric(json.inAmount);
  if(json.inAmount!==undefined&&(inAmount===null||inAmount!==ctx.amount))return base('UNVERIFIED','Quote was for a different input amount than requested.',ctx);
  var out=numeric(json.outAmount);
  if(out===null){
    var msg=String(json.errorMessage||json.error||'');
    return base(/route|liquidity|no .*(pool|market)/i.test(msg)?'NO_ROUTE':'UNVERIFIED',msg?msg.slice(0,200):'Quote response had no output amount.',ctx);
  }
  if(out<=0n)return base('NO_ROUTE','Quoted output is zero.',ctx);
  var scale=Math.pow(10,USDC_DECIMALS),outUsd=Number(out)/scale,min=numeric(json.otherAmountThreshold);
  var impact=typeof json.priceImpact==='number'&&Number.isFinite(json.priceImpact)?json.priceImpact:typeof json.priceImpactPct==='string'&&json.priceImpactPct.trim()&&Number.isFinite(Number(json.priceImpactPct))?Number(json.priceImpactPct)*100:null;
  var plan=Array.isArray(json.routePlan)?json.routePlan.map(function(s){return s&&s.swapInfo&&s.swapInfo.label}).filter(function(l){return typeof l==='string'}).slice(0,6):[];
  var platform=json.platformFee&&typeof json.platformFee.feeBps==='number'?json.platformFee.feeBps:null;
  return base('ROUTE_AVAILABLE','',ctx,{outUsd:outUsd,minOutUsd:min===null?null:Number(min)/scale,slippageBps:typeof json.slippageBps==='number'?json.slippageBps:null,priceImpactPct:impact,feeBps:typeof json.feeBps==='number'?json.feeBps:null,platformFeeBps:platform,router:typeof json.router==='string'?json.router:null,route:plan,shortfallPct:ctx.markUsd>0?(1-outUsd/ctx.markUsd)*100:null});
}
function failed(e,ctx){
  var status=e&&e.status,msg=String(e&&e.message||e).slice(0,200);
  var body=e&&e.body&&typeof e.body==='object'?String(e.body.error||e.body.errorMessage||''):'';
  if(status===400||status===404)return base(/route|liquidity|no .*(pool|market)/i.test(body+' '+msg)?'NO_ROUTE':'UNVERIFIED',(body||msg),ctx);
  return base('UNVERIFIED',msg,ctx);
}
// Effective state at display time: a successful quote ages into STALE rather than being presented as current.
function effective(q,now){return q&&q.status==='ROUTE_AVAILABLE'&&now-q.quotedAt>FRESH_MS?Object.assign({},q,{status:'STALE'}):q}
function createQuoteClient(gate,options){
  options=options||{};var now=options.now||Date.now,cacheMs=options.cacheMs===undefined?15000:options.cacheMs;
  // Sell quote for an exact token amount into USDC. No taker is sent, so no transaction is built and no wallet is involved.
  function quoteSell(args){
    var ctx={now:now(),inputMint:args.mint,outputMint:USDC,amount:args.amount,sellUsd:args.sellUsd,markUsd:args.markUsd};
    var url=BASE+'/order?inputMint='+encodeURIComponent(args.mint)+'&outputMint='+USDC+'&amount='+args.amount.toString()+'&slippageBps='+SLIPPAGE_BPS;
    return gate.run(url,{method:'GET',headers:{Accept:'application/json'}},{ttl:cacheMs}).then(function(r){ctx.now=r.fetchedAt;return parseOrder(r.value,ctx)},function(e){return failed(e,ctx)});
  }
  return {quoteSell:quoteSell};
}
var api={USDC:USDC,SLIPPAGE_BPS:SLIPPAGE_BPS,FRESH_MS:FRESH_MS,base:BASE,toBaseUnits:toBaseUnits,parseOrder:parseOrder,effective:effective,createQuoteClient:createQuoteClient};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftQuotes=api;
})(typeof globalThis!=='undefined'?globalThis:window);
