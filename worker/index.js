// NIGHTSHIFT proxy for Cloudflare Workers. It holds the provider keys (Worker secrets) so they never reach the browser.
// It forwards only the read-only calls the scanner makes and refuses everything else. It never signs, sends or builds transactions.
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_ORIGINS='https://godthefather1952.github.io';
const DEFAULT_RPC='https://mainnet.helius-rpc.com/';
const DEFAULT_QUOTE='https://api.jup.ag/swap/v2/order';
const RPC_METHODS={getAccountInfo:120,getMultipleAccounts:60,getTokenLargestAccounts:120};
const ENCODINGS=['base64','jsonParsed'],COMMITMENTS=['finalized','confirmed'];
const MAX_BODY=4096,MAX_ADDRESSES=5,QUOTE_TTL=10,TIMEOUT_MS=8000,MAX_CACHE=200;
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const cache=new Map();
function validAddress(a){
  if(typeof a!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))return false;
  let n=0n;for(const ch of a)n=n*58n+BigInt(ALPHABET.indexOf(ch));
  let bytes=0;while(n>0n){bytes++;n>>=8n}
  let zeros=0;while(a[zeros]==='1')zeros++;
  return bytes+zeros===32;
}
function allowedOrigins(env){return String(env.ALLOWED_ORIGINS||DEFAULT_ORIGINS).split(',').map(s=>s.trim()).filter(Boolean)}
function corsHeaders(origin){return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Accept','Access-Control-Max-Age':'600',Vary:'Origin'}}
function reply(status,body,origin,extra){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(origin?corsHeaders(origin):{}),...extra}})}
function options(params){
  if(params===undefined)return {};
  if(!params||typeof params!=='object'||Array.isArray(params))return null;
  for(const k of Object.keys(params)){
    if(k==='encoding'&&ENCODINGS.includes(params[k]))continue;
    if(k==='commitment'&&COMMITMENTS.includes(params[k]))continue;
    return null;
  }
  return params;
}
// Returns a normalised JSON-RPC request, or a string describing why it is refused.
function checkRpc(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return 'Batch or non-object requests are not allowed';
  if(body.jsonrpc!=='2.0'||!(typeof body.id==='number'||typeof body.id==='string'))return 'Invalid JSON-RPC envelope';
  if(!Object.prototype.hasOwnProperty.call(RPC_METHODS,body.method))return 'Method not allowed';
  const p=body.params;if(!Array.isArray(p)||p.length<1||p.length>2)return 'Invalid params';
  if(body.method==='getMultipleAccounts'){
    if(!Array.isArray(p[0])||p[0].length<1||p[0].length>MAX_ADDRESSES||!p[0].every(validAddress))return 'Invalid account list';
  }else if(!validAddress(p[0]))return 'Invalid address';
  if(options(p[1])===null)return 'Invalid options';
  return {jsonrpc:'2.0',id:body.id,method:body.method,params:p};
}
function checkQuote(url){
  const q=url.searchParams,allowed=['inputMint','outputMint','amount','slippageBps'];
  for(const k of q.keys())if(!allowed.includes(k))return 'Parameter not allowed: '+k.slice(0,32);
  const input=q.get('inputMint'),output=q.get('outputMint'),amount=q.get('amount'),slip=q.get('slippageBps');
  if(!validAddress(input))return 'Invalid inputMint';
  if(output!==USDC)return 'Only USDC output is supported';
  if(!/^[1-9]\d{0,19}$/.test(amount||''))return 'Invalid amount';
  if(slip!==null&&!(/^\d{1,4}$/.test(slip)&&+slip<=1000))return 'Invalid slippageBps';
  const out=new URLSearchParams({inputMint:input,outputMint:USDC,amount});if(slip!==null)out.set('slippageBps',slip);
  return out;
}
function remember(key,status,text,seconds,now){
  cache.set(key,{status,text,until:now+seconds*1000});
  while(cache.size>MAX_CACHE)cache.delete(cache.keys().next().value);
}
async function upstream(url,init){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{return await fetch(url,{...init,signal:c.signal,redirect:'error'})}finally{clearTimeout(t)}
}
function relay(res,text,origin){
  const extra={};const ra=res.headers&&res.headers.get&&res.headers.get('retry-after');if(ra&&/^\d{1,5}$/.test(ra))extra['Retry-After']=ra;
  return new Response(text,{status:res.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...corsHeaders(origin),...extra}});
}
async function handle(request,env,now){
  const url=new URL(request.url),origin=request.headers.get('Origin');
  if(!origin||!allowedOrigins(env).includes(origin))return reply(403,{error:'Origin not allowed'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(origin)});
  if(url.pathname==='/rpc'&&request.method==='POST'){
    if(!env.HELIUS_API_KEY)return reply(503,{error:'Proxy is not configured'},origin);
    const raw=await request.text();
    if(raw.length>MAX_BODY)return reply(413,{error:'Request too large'},origin);
    let body;try{body=JSON.parse(raw)}catch(e){return reply(400,{error:'Invalid JSON'},origin)}
    const checked=checkRpc(body);if(typeof checked==='string')return reply(400,{error:checked},origin);
    const key='rpc:'+JSON.stringify([checked.method,checked.params]),hit=cache.get(key);
    if(hit&&hit.until>now){const out=JSON.parse(hit.text);out.id=checked.id;return relay({status:hit.status,headers:new Headers()},JSON.stringify(out),origin)}
    let res;try{res=await upstream((env.RPC_UPSTREAM||DEFAULT_RPC)+'?api-key='+encodeURIComponent(env.HELIUS_API_KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(checked)})}catch(e){return reply(502,{error:'RPC provider unreachable'},origin)}
    const text=await res.text();
    if(res.ok){try{if(JSON.parse(text).result)remember(key,res.status,text,RPC_METHODS[checked.method],now)}catch(e){return reply(502,{error:'RPC provider returned invalid JSON'},origin)}}
    return relay(res,text,origin);
  }
  if(url.pathname==='/order'&&request.method==='GET'){
    if(!env.JUPITER_API_KEY)return reply(503,{error:'Proxy is not configured'},origin);
    const params=checkQuote(url);if(typeof params==='string')return reply(400,{error:params},origin);
    const target=(env.QUOTE_UPSTREAM||DEFAULT_QUOTE)+'?'+params.toString(),key='quote:'+target,hit=cache.get(key);
    if(hit&&hit.until>now)return relay({status:hit.status,headers:new Headers()},hit.text,origin);
    let res;try{res=await upstream(target,{method:'GET',headers:{Accept:'application/json','x-api-key':env.JUPITER_API_KEY}})}catch(e){return reply(502,{error:'Quote provider unreachable'},origin)}
    const text=await res.text();
    if(res.ok)remember(key,res.status,text,QUOTE_TTL,now);
    return relay(res,text,origin);
  }
  return reply(404,{error:'Not found'},origin);
}
export default {fetch(request,env){return handle(request,env||{},Date.now())}};
export {handle,checkRpc,checkQuote,validAddress,cache};
