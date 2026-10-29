// Run from repo root: node --test tests/browser-failures.cjs
// BROWSER=webkit selects iPhone-emulated WebKit, not an actual iPhone Safari test.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium,webkit,devices}=require('playwright');
const fs=require('node:fs');
const {serve,pair,rpcResponse,jupiter,A,B,C,POOL}=require('./browser-fixtures.cjs');
let browser,server,origin;
before(async()=>{
 ({server,origin}=await serve());
 const engine=process.env.BROWSER==='webkit'?webkit:chromium;
 browser=await engine.launch({headless:true,...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
async function setup(t,options={}){
 const context=await browser.newContext(process.env.BROWSER==='webkit'?devices['iPhone 13']:{viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 const calls=[],quoteCalls=[];let market=options.market||[pair()];
 await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?market:market.map(p=>({chainId:'solana',tokenAddress:p.baseToken.address}))}));
 await page.route(/https:\/\/(solana-rpc\.publicnode\.com|solana\.api\.onfinality\.io|api\.mainnet\.solana\.com)\//,async route=>{
  const q=route.request().postDataJSON();calls.push({host:new URL(route.request().url()).hostname,method:q.method,address:Array.isArray(q.params[0])?q.params[0].join(','):q.params[0],at:Date.now()});
  if(options.rpc)return options.rpc(route,q);
  return route.fulfill({json:rpcResponse(q,options.chain)});
 });
 await page.route('https://api.jup.ag/**',route=>{quoteCalls.push(route.request().url());return options.quote?options.quote(route):route.fulfill({json:jupiter(route.request().url())})});
 await page.goto(origin);await page.waitForFunction(()=>Number(document.querySelector('#scanned').textContent)>0);
 return {page,calls,quoteCalls,setMarket(v){market=v}};
}
async function review(page,address=A){if(await page.locator('#close').isVisible())await page.locator('#close').click();await page.locator('[data-nav="discover"]').click();await page.locator('#candidates [data-review="'+address+'"]').click();await page.locator('#approveBtn').waitFor()}
async function stored(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state)}
test('unknown liquidity is AWAITING DATA, zero is REJECTED, both disable approval',async t=>{
 for(const usd of [null,0]){await t.test(String(usd),async t=>{const {page,calls}=await setup(t,{market:[{...pair(),liquidity:{usd}}]});await review(page);const text=await page.locator('#review').innerText();assert.match(text,usd===null?/Liquidity UNKNOWN[\s\S]*AWAITING DATA/:/below the \$10,000 hard floor[\s\S]*REJECTED/);assert.equal(await page.locator('#approveBtn').isEnabled(),false);assert.equal(calls.length,0);assert.equal((await stored(page)).positions.length,0)})}
});
test('holder-only outage shows partial checks, each provider error and disabled approval',async t=>{
 const {page,calls}=await setup(t,{rpc:(route,q)=>q.method==='getTokenLargestAccounts'?route.fulfill({status:429,json:{error:'rate limited'}}):route.fulfill({json:rpcResponse(q)})});
 await page.waitForFunction(()=>document.querySelector('#dataHealth').textContent.includes('api.mainnet.solana.com'));
 await review(page);await page.waitForFunction(()=>document.querySelector('#review').innerText.includes('getTokenLargestAccounts unavailable'));
 const text=await page.locator('#review').innerText();assert.match(text,/Mint authority[\s\S]*?Disabled[\s\S]*?VERIFIED/);assert.match(text,/Pool vaults[\s\S]*?VERIFIED/);assert.match(text,/Top 10 accounts \(raw\)[\s\S]*?UNKNOWN/);assert.match(text,/infrastructure-adjusted\)[\s\S]*?UNKNOWN/);assert.match(text,/getTokenLargestAccounts unavailable/);assert.match(text,/429/);assert.match(text,/AWAITING DATA/);assert.equal(await page.locator('#approveBtn').isEnabled(),false);
 assert.deepEqual([...new Set(calls.filter(c=>c.method==='getTokenLargestAccounts').map(c=>c.host))],['solana-rpc.publicnode.com','solana.api.onfinality.io','api.mainnet.solana.com']);assert.equal((await stored(page)).positions.length,0);
});
test('all providers fail: unknown safety, visible errors, no approval',async t=>{
 const {page}=await setup(t,{rpc:route=>route.fulfill({status:503,json:{error:'unavailable'}})});
 await page.waitForFunction(()=>document.querySelector('#dataHealth').textContent.includes('getTokenLargestAccounts: HTTP 503')&&document.querySelector('#refresh').textContent==='LIVE');
 await review(page);await page.waitForFunction(()=>document.querySelector('#review').innerText.includes('getAccountInfo unavailable'));
 const text=await page.locator('#review').innerText();assert.doesNotMatch(text,/Verified Safety/);assert.match(text,/0 verified/);assert.match(text,/Pool program[\s\S]*?UNKNOWN/);assert.match(text,/Mint authority[\s\S]*?UNKNOWN/);assert.match(text,/503/);assert.equal(await page.locator('#approveBtn').isEnabled(),false);assert.equal((await stored(page)).positions.length,0);
});
test('late verification cannot replace a different open review',async t=>{
 let release;const gate=new Promise(r=>release=r);t.after(()=>release());
 const {page}=await setup(t,{market:[pair(),pair(B,'SECOND')],rpc:async(route,q)=>{if(q.params[0]===A)await gate;return route.fulfill({json:rpcResponse(q)})}});
 await review(page,A);await page.locator('#close').click();await page.locator('#candidates [data-review="'+B+'"]').click();assert.match(await page.locator('#review h2').innerText(),/SECOND/);assert.equal(await page.locator('#approveBtn').isEnabled(),false);
 release();await page.waitForFunction(()=>document.querySelector('#ready').textContent==='2');await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#review').innerText));assert.match(await page.locator('#review h2').innerText(),/SECOND/);assert.equal(await page.locator('#approveBtn').isEnabled(),true);assert.equal((await stored(page)).positions.length,0);
});
test('unknown position liquidity keeps fresh-price stops armed; confirmed zero liquidity exits',async t=>{
 const {page,setMarket}=await setup(t);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await review(page);await page.locator('#approveBtn').click();assert.equal((await stored(page)).positions.length,1);
 await review(page);assert.equal(await page.locator('#approveBtn').isEnabled(),false);assert.match(await page.locator('#approveBtn').innerText(),/Already tracking/);await page.locator('#close').click();
 setMarket([pair(A,'FIRST',{liquidity:{usd:null},priceUsd:'1.02'})]);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions[0]?.liquidityKnown===false,{},{timeout:20000});
 let state=await stored(page);assert.equal(state.positions.length,1);assert.equal(state.positions[0].stale,false);assert.equal(state.positions[0].current,1.02);assert.equal(state.history.filter(h=>h.type==='WIN'||h.type==='LOSS').length,0);
 await page.locator('[data-nav="positions"]').click();const text=await page.locator('#positionsList').innerText();assert.match(text,/Liquidity UNKNOWN: price stops stay active/);assert.doesNotMatch(text,/STALE/);
 setMarket([pair(A,'FIRST',{liquidity:{usd:0}})]);await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions.length===0,{},{timeout:20000});
 state=await stored(page);assert.equal(state.history.filter(h=>h.type==='WIN'||h.type==='LOSS').length,1);assert.match(state.history[0].note,/Liquidity fell below/);
});
test('price stop fires from a fresh price even though liquidity is unknown, with no fabricated fill',async t=>{
 const {page,setMarket}=await setup(t);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await review(page);await page.locator('#approveBtn').click();
 setMarket([pair(A,'FIRST',{liquidity:{usd:null},priceUsd:'.8'})]);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions.length===0,{},{timeout:20000});
 const state=await stored(page);assert.match(state.history[0].note,/Protective stop[\s\S]*no fill or executable quote is assumed/);
});
test('browser RPC requests are paced; cooldown suppresses requests then permits retry',async t=>{
 let fail=true;const {page,calls}=await setup(t,{market:[{...pair(),liquidity:{usd:null}}],rpc:route=>fail?route.fulfill({status:503,json:{error:'outage'}}):route.fulfill({json:{result:{value:[]}}})});
 await page.evaluate(()=>{window.probeOffset=0;window.testRpc=NightshiftData.createRpc(async(url,opt)=>{const r=await fetch(url,opt);if(!r.ok)throw Error('HTTP '+r.status);return r.json()},{now:()=>Date.now()+window.probeOffset})});
 const attempt=()=>page.evaluate(async()=>{try{await window.testRpc.request('getTokenLargestAccounts',['test']);return 'success'}catch(e){return e.message}});
 assert.match(await attempt(),/unavailable/);assert.equal(calls.length,3);
 for(let i=1;i<calls.length;i++)assert.ok(calls[i].at-calls[i-1].at>=325,'350ms pacing with 25ms observer tolerance');
 assert.match(await attempt(),/cooldown/);assert.equal(calls.length,3);
 fail=false;await page.evaluate(()=>window.probeOffset+=61000);assert.equal(await attempt(),'success');assert.equal(calls.length,4);
 assert.equal(await attempt(),'success');assert.equal(calls.length,4,'successful response cached');
});
test('Ready shows per-check evidence with sources and times, a pool verified on-chain, and no safety score',async t=>{
 const {page,calls}=await setup(t);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await review(page);
 await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#review').innerText));
 const text=await page.locator('#review').innerText();assert.doesNotMatch(text,/Verified Safety|100\/100|Coverage \d+%/);assert.match(text,/Evidence/);assert.match(text,/no safety score or probability of safety/);
 for(const re of [/Pool program[\s\S]*?Raydium CPMM owns pool[\s\S]*?Solana RPC \(finalized\) · checked [^\n]*\s+VERIFIED/,/Pool token mints[\s\S]*?VERIFIED/,/Pool vaults[\s\S]*?VERIFIED/,/Top 10 accounts \(infrastructure-adjusted\)[\s\S]*?excluding 2 verified pool vault|Top 10 accounts \(infrastructure-adjusted\)[\s\S]*?VERIFIED/,/Minimum liquidity[\s\S]*?DexScreener \(not verified on-chain\)[\s\S]*?REPORTED/,/Deployer history[\s\S]*?NOT CHECKED/,/Insider \/ bundle clustering[\s\S]*?NOT CHECKED/,/Sell route[\s\S]*?REPORTED/,/Estimated output[\s\S]*Minimum output[\s\S]*Price impact[\s\S]*Fees[\s\S]*Route/])assert.match(text,re);
 assert.equal(await page.locator('#approveBtn').isEnabled(),true);assert.deepEqual([...new Set(calls.map(c=>c.method))].sort(),['getAccountInfo','getMultipleAccounts','getTokenLargestAccounts']);
});
test('pool evidence failures block Ready: unknown pool address and a vault holding another mint',async t=>{
 for(const [name,over,market,re] of [['no pool address',{},[pair(A,'FIRST',{pairAddress:undefined})],/Pool program[\s\S]*?UNKNOWN/],['vault mint mismatch',{chain:{vaults:[require('./browser-fixtures.cjs').vaultAccount(B),require('./browser-fixtures.cjs').vaultAccount(C)]}},[pair()],/Pool vaults[\s\S]*?FAILED/]]){
  await t.test(name,async t=>{const {page}=await setup(t,{market,...over});await review(page).catch(()=>{});
   await page.waitForFunction(()=>!/Pool verification has not run/.test(document.querySelector('#review').innerText));
   const text=await page.locator('#review').innerText();assert.match(text,re);assert.equal(await page.locator('#approveBtn').isEnabled(),false);assert.equal((await stored(page)).positions.length,0)})}
});
test('approval fails closed: a definitive no-route and an unreachable quote provider both block approval',async t=>{
 for(const [name,quote,enabled,re] of [['no route',route=>route.fulfill({status:400,json:{error:'Could not find any route'}}),false,/NO ROUTE FOUND/],['provider down',route=>route.fulfill({status:429,json:{error:'rate'}}),false,/NOT VERIFIED/]]){
  await t.test(name,async t=>{const {page}=await setup(t,{quote});await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await review(page);await page.waitForFunction(()=>/NO ROUTE FOUND|NOT VERIFIED/.test(document.querySelector('#review').innerText));assert.match(await page.locator('#review').innerText(),re);assert.equal(await page.locator('#approveBtn').isEnabled(),enabled);assert.equal((await stored(page)).positions.length,0)})}
});
test('quotes follow the selected size and a tracked position can be quoted for its remaining amount',async t=>{
 const {page,quoteCalls}=await setup(t);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await review(page);await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#review').innerText));
 await page.locator('[data-size="20"]').click();await page.waitForFunction(()=>/\$20\.00 at mark/.test(document.querySelector('#review').innerText),{},{timeout:15000});
 const amounts=quoteCalls.map(u=>new URL(u).searchParams.get('amount'));assert.deepEqual([...new Set(amounts)].sort(),['10000000','20000000']);
 await page.locator('#approveBtn').click();await page.locator('[data-nav="positions"]').click();await page.locator('[data-quotepos]').click();await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#positionsList').innerText),{},{timeout:15000});
 assert.match(await page.locator('#positionsList').innerText(),/not an executed swap/);
});
test('Token-2022: benign extensions can be Ready; a permanent delegate, a transfer fee or a missing extension list cannot',async t=>{
 const T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',K='GAhY6goNLmaQwDfYRMBLtbfSacSTdp3kyixmjLZXRq1q';
 const meta=[{extension:'metadataPointer',state:{authority:null,metadataAddress:A}},{extension:'tokenMetadata',state:{updateAuthority:null}}];
 const cases=[['benign',{mintOwner:T22,extensions:meta},true,/Token-2022 extensions[\s\S]*?Only benign or inert extensions: metadataPointer, tokenMetadata[\s\S]*?VERIFIED/],['permanent delegate',{mintOwner:T22,extensions:[...meta,{extension:'permanentDelegate',state:{delegate:K}}]},false,/Token-2022 extensions[\s\S]*?Permanent delegate[\s\S]*?FAILED/],['transfer fee',{mintOwner:T22,extensions:[...meta,{extension:'transferFeeConfig',state:{olderTransferFee:{transferFeeBasisPoints:100},newerTransferFee:{transferFeeBasisPoints:100},transferFeeConfigAuthority:null}}]},false,/1% fee[\s\S]*?FAILED/],['no extension list',{mintOwner:T22},false,/Token-2022 extensions[\s\S]*?UNKNOWN/]];
 for(const [name,chain,enabled,re] of cases){
  await t.test(name,async t=>{const {page}=await setup(t,{chain});await page.waitForFunction(()=>Number(document.querySelector('#scanned').textContent)>0);await review(page);await page.waitForFunction(()=>!/Validating/.test(document.querySelector('#review').innerText)&&/Token-2022 extensions|Safety status/.test(document.querySelector('#review').innerText)&&!/Pool verification has not run/.test(document.querySelector('#review').innerText));
   if(enabled)await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#review').innerText));const text=await page.locator('#review').innerText();assert.match(text,re);assert.equal(await page.locator('#approveBtn').isEnabled(),enabled);assert.equal((await stored(page)).positions.length,0)})}
});
test('a discovery rate limit does not pause position monitoring (separate DexScreener gates)',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});t.after(()=>context.close());const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 const now=Date.now(),d=new Date(),day=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
 const seeded={app:'NIGHTSHIFT',version:2,state:{positions:[{address:A,pairAddress:POOL,decimals:6,symbol:'FIRST',name:'FIRST',amount:10,entry:1,current:1,opened:now,dayBasis:1,setup:'MOMENTUM',entryLiquidity:200000,remainingPct:1,realizedPnl:0,dayRealized:0,peak:1,stopPct:-12,t1Hit:false,t2Hit:false,trailActive:false,lastPriceAt:now,stale:false}],history:[],evaluations:{},snapshots:{},dismissed:{},daily:{date:day,realized:0},last:0}};
 await page.addInitScript(v=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('nightshift_v1',v);sessionStorage.setItem('seeded','1')}},JSON.stringify(seeded));
 // Discovery's boost feed is rate limited from the start; the token-price endpoint used for positions stays healthy.
 await page.route('https://api.dexscreener.com/**',route=>{const u=route.request().url();if(u.includes('/token-boosts/'))return route.fulfill({status:429,json:{error:'rate limited'}});return route.fulfill({json:u.includes('/tokens/')?[pair()]:[{chainId:'solana',tokenAddress:A}]})});
 await page.route(/https:\/\/(solana-rpc\.publicnode\.com|solana\.api\.onfinality\.io|api\.mainnet\.solana\.com)\//,route=>route.fulfill({json:rpcResponse(route.request().postDataJSON())}));
 await page.route('https://api.jup.ag/**',route=>route.fulfill({json:jupiter(route.request().url())}));
 await page.goto(origin);
 await page.waitForFunction(()=>/api\.dexscreener\.com: HTTP 429/.test(document.querySelector('#dataHealth').textContent),null,{timeout:20000});
 const t0=Date.now();
 // Let the 4-second position price cache lapse, then trigger a monitor pass (as returning to the tab does) instead of waiting for the 15-second timer.
 await page.waitForTimeout(4100);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await page.waitForFunction(at=>{const s=JSON.parse(localStorage.getItem('nightshift_v1')).state;return s.positions[0].lastPriceAt>at&&!s.positions[0].stale},t0,{timeout:30000});
});
