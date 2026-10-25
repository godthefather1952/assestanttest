(function(root){
'use strict';
// Buy versus sell dollars for one verified pool, derived from on-chain vault balance changes in recent transactions.
// A swap that adds quote tokens to the pool's quote vault and removes base tokens from its base vault is a buy; the reverse is a sell.
// Anything else (liquidity changes, transactions that skip a vault, failed transactions) is excluded rather than guessed.
var WINDOW_MS=300000,SIGNATURES=40,MAX_NEW=15,KEEP=200,MIN_TRADE_USD=0.01;
var USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',WSOL='So11111111111111111111111111111111111111112';
function quoteKind(mint){return mint===USDC||mint===USDT?'usd':mint===WSOL?'sol':null}
function big(v){return typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):null}
function keysOf(tx){var k=tx&&tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys;return Array.isArray(k)?k.map(function(x){return typeof x==='string'?x:x&&x.pubkey}):null}
function balanceDelta(meta,index,mint){
  function find(list){var m=(Array.isArray(list)?list:[]).filter(function(b){return b&&b.accountIndex===index});return m.length===1?m[0]:null}
  var pre=find(meta.preTokenBalances),post=find(meta.postTokenBalances);
  if(!post||post.mint!==mint||!post.uiTokenAmount)return null;
  var after=big(post.uiTokenAmount.amount),before=pre?(pre.mint===mint&&pre.uiTokenAmount?big(pre.uiTokenAmount.amount):null):0n;
  if(after===null||before===null)return null;
  return {delta:after-before,decimals:post.uiTokenAmount.decimals};
}
// Returns {t, side:'buy'|'sell', usd} for a swap through this pool, or null when the transaction is not a clean swap.
function parseSwap(tx,ctx){
  if(!tx||!tx.meta||tx.meta.err||!Number.isFinite(tx.blockTime))return null;
  var keys=keysOf(tx);if(!keys)return null;
  var qi=keys.indexOf(ctx.quoteVault),bi=keys.indexOf(ctx.baseVault);if(qi<0||bi<0)return null;
  var q=balanceDelta(tx.meta,qi,ctx.quoteMint),b=balanceDelta(tx.meta,bi,ctx.baseMint);
  if(!q||!b||!Number.isInteger(q.decimals)||q.decimals<0||q.decimals>18)return null;
  var side=q.delta>0n&&b.delta<0n?'buy':q.delta<0n&&b.delta>0n?'sell':null;if(!side)return null;
  var abs=q.delta<0n?-q.delta:q.delta,usd=Number(abs)/Math.pow(10,q.decimals)*ctx.quoteUsd;
  return Number.isFinite(usd)&&usd>=MIN_TRADE_USD?{t:tx.blockTime*1000,side:side,usd:usd}:null;
}
function aggregate(sigs,store,now,windowMs){
  windowMs=windowMs||WINDOW_MS;var start=now-windowMs;
  var inWindow=sigs.filter(function(s){return !s.err&&Number.isFinite(s.blockTime)&&s.blockTime*1000>=start});
  var m={status:'OK',at:now,windowSec:Math.round(windowMs/1000),buyUsd:0,sellUsd:0,buys:0,sells:0,largestBuy:0,largestSell:0,inWindow:inWindow.length,parsed:0,swaps:0,newest:null,oldest:null};
  inWindow.forEach(function(s){
    var r=store.get(s.signature);if(r===undefined)return;m.parsed++;if(!r.side)return;
    m.swaps++;m.newest=Math.max(m.newest||0,r.t);m.oldest=Math.min(m.oldest||Infinity,r.t);
    if(r.side==='buy'){m.buyUsd+=r.usd;m.buys++;m.largestBuy=Math.max(m.largestBuy,r.usd)}else{m.sellUsd+=r.usd;m.sells++;m.largestSell=Math.max(m.largestSell,r.usd)}
  });
  m.totalUsd=m.buyUsd+m.sellUsd;m.sellShare=m.totalUsd>0?m.sellUsd/m.totalUsd:null;
  // complete only if every signature in the window was read and the fetched page reached back past the window start.
  var reachedStart=sigs.length<SIGNATURES||sigs.some(function(s){return Number.isFinite(s.blockTime)&&s.blockTime*1000<start});
  m.complete=m.parsed===m.inWindow&&reachedStart;
  return m;
}
function createFlowTracker(request,options){
  options=options||{};var now=options.now||Date.now,stores=new Map();
  // ctx: {quoteVault, baseVault, quoteMint, baseMint, quoteUsd}
  async function refresh(ctx){
    if(!(ctx.quoteUsd>0)||!quoteKind(ctx.quoteMint))throw Error('Quote token is not supported for dollar flow.');
    var sigs=await request('getSignaturesForAddress',[ctx.quoteVault,{limit:SIGNATURES,commitment:'confirmed'}]);
    if(!Array.isArray(sigs)||sigs.some(function(s){return !s||typeof s.signature!=='string'}))throw Error('Signature list was not in the expected shape.');
    var store=stores.get(ctx.quoteVault);if(!store){store=new Map();stores.set(ctx.quoteVault,store)}
    var todo=sigs.filter(function(s){return !s.err&&Number.isFinite(s.blockTime)&&!store.has(s.signature)}).slice(0,MAX_NEW);
    for(var i=0;i<todo.length;i++){
      var tx=await request('getTransaction',[todo[i].signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
      if(!tx)continue;
      var swap=parseSwap(tx,ctx);store.set(todo[i].signature,swap||{t:todo[i].blockTime*1000});
    }
    while(store.size>KEEP)store.delete(store.keys().next().value);
    return aggregate(sigs,store,now());
  }
  return {refresh:refresh};
}
var api={WINDOW_MS:WINDOW_MS,SIGNATURES:SIGNATURES,MAX_NEW:MAX_NEW,quoteKind:quoteKind,parseSwap:parseSwap,aggregate:aggregate,createFlowTracker:createFlowTracker};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftFlow=api;
})(typeof globalThis!=='undefined'?globalThis:window);
