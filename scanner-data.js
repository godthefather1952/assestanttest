(function(root){
'use strict';
var ENDPOINTS=['https://solana-rpc.publicnode.com','https://solana.api.onfinality.io/public','https://api.mainnet.solana.com'];
function liquidity(pair){
  var value=pair&&pair.liquidity&&pair.liquidity.usd;
  if(value===null||value===undefined||typeof value==='boolean'||(typeof value==='string'&&!value.trim()))return null;
  return Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
}
function poolSupported(pair){return ['raydium','orca','meteora','pumpswap'].indexOf(String(pair&&pair.dexId||'').toLowerCase())>=0}
function marketStatus(pair){return poolSupported(pair)?'Pool market':String(pair&&pair.dexId||'').toLowerCase()==='pumpfun'?'Bonding curve — unsupported':'Market type unsupported'}
function createRpc(fetcher,options){
  options=options||{};
  var now=options.now||Date.now,wait=options.wait||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})};
  var endpoints=options.endpoints||ENDPOINTS,cache=new Map(),pending=new Map(),health={},tail=Promise.resolve(),nextAt=0;
  function request(method,params){
    var key=JSON.stringify([method,params]),cached=cache.get(key);
    if(cached&&now()-cached.time<60000)return Promise.resolve(cached.value);
    if(pending.has(key))return pending.get(key);
    var work=tail.then(async function(){
      var errors=[];
      for(var i=0;i<endpoints.length;i++){
        var url=endpoints[i],hk=url+' '+method,h=health[hk];
        if(h&&h.retryAt>now()){errors.push(new URL(url).hostname+': '+h.message+' (cooldown)');continue}
        await wait(Math.max(0,nextAt-now()));nextAt=now()+350;
        try{
          var result=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})});
          if(result.error)throw Error('RPC '+result.error.code+': '+String(result.error.message).slice(0,160));
          if(!result.result||!Object.prototype.hasOwnProperty.call(result.result,'value'))throw Error('Malformed RPC response');
          health[hk]={message:'OK',time:now(),retryAt:0};
          cache.set(key,{time:now(),value:result.result});
          while(cache.size>128)cache.delete(cache.keys().next().value);
          return result.result;
        }catch(e){
          var message=e.name==='AbortError'?'Timed out':e instanceof TypeError?'Network/CORS connection failed':String(e.message||e).slice(0,200);
          health[hk]={message:message,time:now(),retryAt:now()+60000};
          errors.push(new URL(url).hostname+': '+message);
        }
      }
      throw Error(method+' unavailable — '+errors.join('; '));
    });
    pending.set(key,work);tail=work.catch(function(){});
    work.then(function(){pending.delete(key)},function(){pending.delete(key)});
    return work;
  }
  return {request:request,health:health};
}
var api={liquidity:liquidity,poolSupported:poolSupported,marketStatus:marketStatus,createRpc:createRpc,endpoints:ENDPOINTS};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftData=api;
})(typeof globalThis!=='undefined'?globalThis:window);
