(function(root){
'use strict';
var config=root.NightshiftConfig||{};
var ENDPOINTS=Array.isArray(config.rpcEndpoints)&&config.rpcEndpoints.length?config.rpcEndpoints.slice():['https://solana-rpc.publicnode.com','https://solana.api.onfinality.io/public','https://api.mainnet.solana.com'];
var CACHE_TTL={getAccountInfo:120000,getTokenLargestAccounts:120000,getMultipleAccounts:60000};
var STALE_MAX=600000,MAX_COOLDOWN=900000;
function liquidity(pair){
  var value=pair&&pair.liquidity&&pair.liquidity.usd;
  if(value===null||value===undefined||typeof value==='boolean'||(typeof value==='string'&&!value.trim()))return null;
  return Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
}
function poolSupported(pair){return ['raydium','orca','meteora','pumpswap'].indexOf(String(pair&&pair.dexId||'').toLowerCase())>=0}
function marketStatus(pair){return poolSupported(pair)?'Pool market':String(pair&&pair.dexId||'').toLowerCase()==='pumpfun'?'Bonding curve — unsupported':'Market type unsupported'}
// Classifies a provider failure so cooldowns match the cause instead of one flat penalty.
function classify(e){
  var message=String(e&&e.message||e),status=e&&e.status,m;
  if(!status&&(m=/^(?:HTTP )?(\d{3})$/.exec(message)))status=+m[1];
  if(!status&&(m=/\bHTTP (\d{3})\b/.exec(message)))status=+m[1];
  if(e&&e.name==='AbortError')return {kind:'timeout',base:30000,message:'Timed out'};
  if(e instanceof TypeError)return {kind:'network',base:60000,message:'Network/CORS connection failed'};
  if(status===429)return {kind:'rate_limited',base:60000,message:'HTTP 429 rate limited'};
  if(status===401||status===403)return {kind:'blocked',base:600000,message:'HTTP '+status+' rejected by provider'};
  if(status>=500)return {kind:'server',base:60000,message:'HTTP '+status+' provider error'};
  if(status>=400)return {kind:'client',base:120000,message:'HTTP '+status};
  if(/RPC -32601|method.*(disabled|not found|not available)/i.test(message))return {kind:'method_disabled',base:1800000,message:message.slice(0,200)};
  return {kind:/Malformed/.test(message)?'malformed':'error',base:60000,message:message.slice(0,200)};
}
function cooldownFor(c,failures,retryAfter){
  var ms=c.base*Math.pow(2,Math.max(0,failures-1));
  if(retryAfter>0)ms=Math.max(ms,retryAfter);
  return Math.min(ms,c.kind==='blocked'||c.kind==='method_disabled'?3600000:MAX_COOLDOWN);
}
function markFailure(health,key,e,now){
  var c=classify(e),old=health[key],failures=(old&&old.failures||0)+1;
  health[key]={message:c.message,kind:c.kind,failures:failures,time:now,retryAt:now+cooldownFor(c,failures,e&&e.retryAfter),lastOk:old&&old.lastOk||0};
  return health[key];
}
function markSuccess(health,key,now){health[key]={message:'OK',kind:'ok',failures:0,time:now,retryAt:0,lastOk:now}}
function cooling(health,key,now){var h=health[key];return h&&h.retryAt>now?h:null}
function seconds(ms){return Math.max(1,Math.ceil(ms/1000))}
function createRpc(fetcher,options){
  options=options||{};
  var now=options.now||Date.now,wait=options.wait||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})};
  var endpoints=options.endpoints||ENDPOINTS,ttl=Object.assign({},CACHE_TTL,options.ttl),staleMax=options.staleMax===undefined?STALE_MAX:options.staleMax,gap=options.gap===undefined?350:options.gap;
  var cache=new Map(),pending=new Map(),meta=new Map(),health={},tail=Promise.resolve(),nextAt=0;
  function key(method,params){return JSON.stringify([method,params])}
  function request(method,params){
    var k=key(method,params),cached=cache.get(k),limit=ttl[method]===undefined?60000:ttl[method];
    if(cached&&now()-cached.time<limit)return Promise.resolve(cached.value);
    if(pending.has(k))return pending.get(k);
    var work=tail.then(async function(){
      var errors=[];
      for(var i=0;i<endpoints.length;i++){
        var url=endpoints[i],host=new URL(url).hostname,hk=url+' '+method,h=cooling(health,hk,now());
        if(h){errors.push(host+': '+h.message+' (cooldown '+seconds(h.retryAt-now())+'s)');continue}
        await wait(Math.max(0,nextAt-now()));nextAt=now()+gap;
        try{
          var result=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})});
          if(result.error)throw Error('RPC '+result.error.code+': '+String(result.error.message).slice(0,160));
          if(!result.result||!Object.prototype.hasOwnProperty.call(result.result,'value'))throw Error('Malformed RPC response');
          markSuccess(health,hk,now());
          cache.set(k,{time:now(),value:result.result});meta.set(k,{fetchedAt:now(),stale:false,endpoint:host});
          while(cache.size>128){var oldest=cache.keys().next().value;cache.delete(oldest);meta.delete(oldest)}
          return result.result;
        }catch(e){
          var failed=markFailure(health,hk,e,now());
          errors.push(host+': '+failed.message);
        }
      }
      // Every provider failed: a recent success may still be shown, but only with its original timestamp and a stale flag.
      if(cached&&now()-cached.time<=staleMax){meta.set(k,{fetchedAt:cached.time,stale:true,endpoint:(meta.get(k)||{}).endpoint});return cached.value}
      throw Error(method+' unavailable — '+errors.join('; '));
    });
    pending.set(k,work);tail=work.catch(function(){});
    work.then(function(){pending.delete(k)},function(){pending.delete(k)});
    return work;
  }
  function detailed(method,params){return request(method,params).then(function(result){var m=meta.get(key(method,params))||{};return {result:result,fetchedAt:m.fetchedAt||now(),stale:!!m.stale,endpoint:m.endpoint||null}})}
  return {request:request,detailed:detailed,meta:function(method,params){return meta.get(key(method,params))||null},health:health};
}
// Shared HTTP gate for non-RPC providers: dedupes, caches, paces and cools down after failures.
function createGate(name,fetcher,options){
  options=options||{};
  var now=options.now||Date.now,wait=options.wait||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})},gap=options.gap===undefined?200:options.gap;
  var cache=new Map(),pending=new Map(),health={},tail=Promise.resolve(),nextAt=0,hk=name;
  function run(url,opt,settings){
    settings=settings||{};
    var ttl=settings.ttl||0,k=url+(opt&&opt.body||''),cached=cache.get(k);
    if(cached&&ttl&&now()-cached.time<ttl)return Promise.resolve({value:cached.value,fetchedAt:cached.time,cached:true});
    if(pending.has(k))return pending.get(k);
    var work=tail.then(async function(){
      var h=cooling(health,hk,now());
      if(h)throw Error(name+': '+h.message+' (cooldown '+seconds(h.retryAt-now())+'s)');
      await wait(Math.max(0,nextAt-now()));nextAt=now()+gap;
      try{
        var value=await fetcher(url,opt);
        markSuccess(health,hk,now());
        cache.set(k,{time:now(),value:value});
        while(cache.size>64)cache.delete(cache.keys().next().value);
        return {value:value,fetchedAt:now(),cached:false};
      }catch(e){
        var failed=markFailure(health,hk,e,now());
        var error=Error(name+': '+failed.message);error.kind=failed.kind;error.status=e&&e.status;error.body=e&&e.body;throw error;
      }
    });
    pending.set(k,work);tail=work.catch(function(){});
    work.then(function(){pending.delete(k)},function(){pending.delete(k)});
    return work;
  }
  return {run:run,health:health,name:name};
}
// Human-readable provider status lines for the UI: one per provider/method, with cooldown time remaining.
function describeHealth(healthMaps,now){
  now=now===undefined?Date.now():now;var lines=[];
  healthMaps.forEach(function(map){Object.keys(map).forEach(function(k){
    var h=map[k],space=k.indexOf(' '),target=space>0?(function(){try{return new URL(k.slice(0,space)).hostname}catch(e){return k.slice(0,space)}})()+' · '+k.slice(space+1):k;
    var state=h.kind==='ok'?'OK':h.message+(h.retryAt>now?' — retry in '+seconds(h.retryAt-now)+'s':' — retry allowed')+(h.failures>1?' ('+h.failures+' failures)':'');
    lines.push(target+': '+state);
  })});
  return lines;
}
var api={liquidity:liquidity,poolSupported:poolSupported,marketStatus:marketStatus,createRpc:createRpc,createGate:createGate,classify:classify,describeHealth:describeHealth,endpoints:ENDPOINTS,config:config};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftData=api;
})(typeof globalThis!=='undefined'?globalThis:window);
