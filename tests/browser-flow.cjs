// Run from repo root: node --test tests/browser-flow.cjs  (BROWSER=webkit for iPhone-emulated WebKit; not real iPhone Safari)
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium,webkit,devices}=require('playwright');
const {serve,pair,rpcResponse,jupiter,A,USDC,poolAccount,vaultAccount}=require('./browser-fixtures.cjs');
const {VAULT_A,VAULT_B}=require('./harness.cjs');
const HK='11111111-2222-3333-4444-555555555555';
let browser,server,origin;
before(async()=>{({server,origin}=await serve());const engine=process.env.BROWSER==='webkit'?webkit:chromium;browser=await engine.launch({headless:true,...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})})});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
const usdcPair=(over={})=>pair(A,'FIRST',{quoteToken:{address:USDC,symbol:'USDC',name:'USD Coin'},...over});
const chain={pool:poolAccount(A,USDC),vaults:[vaultAccount(A),vaultAccount(USDC)]};
// quote vault = VAULT_B (index 3), base vault = VAULT_A (index 4); a sell removes quote and adds base
function swapTx(side,sig){const t=Math.floor(Date.now()/1000),qPre=5000000000,bPre=1000000000,q=side==='sell'?qPre-100000000:qPre+100000000,b=side==='sell'?bPre+1000000:bPre-1000000;const bal=(i,mint,amount)=>({accountIndex:i,mint,uiTokenAmount:{amount:String(amount),decimals:6}});return {blockTime:t,meta:{err:null,preTokenBalances:[bal(3,USDC,qPre),bal(4,A,bPre)],postTokenBalances:[bal(3,USDC,q),bal(4,A,b)]},transaction:{message:{accountKeys:['x','y','z',VAULT_B,VAULT_A].map(pubkey=>({pubkey}))}}}}
async function open(t,side){
  const context=await browser.newContext(process.env.BROWSER==='webkit'?devices['iPhone 13']:{viewport:{width:390,height:844},hasTouch:true,isMobile:true});t.after(()=>context.close());
  await context.addInitScript(k=>{try{if(!localStorage.getItem('nightshift_keys_v1'))localStorage.setItem('nightshift_keys_v1',JSON.stringify({helius:k,jupiter:''}))}catch(e){}},HK);
  const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  const state={market:[usdcPair()],reads:{signatures:0,transactions:0}};
  await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?state.market:state.market.map(p=>({chainId:'solana',tokenAddress:p.baseToken.address}))}));
  await page.route('https://mainnet.helius-rpc.com/**',route=>{const q=route.request().postDataJSON();
    if(q.method==='getSignaturesForAddress'){state.reads.signatures++;const t=Math.floor(Date.now()/1000);return route.fulfill({json:{jsonrpc:'2.0',id:1,result:Array.from({length:10},(_,i)=>({signature:'sig'+i,blockTime:t,err:null}))}})}
    if(q.method==='getTransaction'){state.reads.transactions++;return route.fulfill({json:{jsonrpc:'2.0',id:1,result:swapTx(side)}})}
    return route.fulfill({json:rpcResponse(q,chain)})});
  await page.route(/https:\/\/(solana-rpc\.publicnode\.com|solana\.api\.onfinality\.io|api\.mainnet\.solana\.com)\//,route=>route.fulfill({status:429,json:{error:'rate'}}));
  await page.route('https://api.jup.ag/**',route=>route.fulfill({json:jupiter(route.request().url())}));
  await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');
  await page.locator('[data-nav="discover"]').click();await page.locator('#candidates [data-review="'+A+'"]').click();await page.waitForFunction(()=>document.querySelector('#approveBtn')&&!document.querySelector('#approveBtn').disabled);await page.locator('#approveBtn').click();
  return {page,state};
}
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state);
test('with a Helius key an approved position records its vaults and shows buy and sell dollars read from on-chain swaps',async t=>{
  const {page,state}=await open(t,'buy');assert.deepEqual(Object.keys((await stored(page)).positions[0].flowCfg).sort(),['baseMint','baseVault','quoteMint','quoteVault']);
  await page.locator('[data-nav="positions"]').click();await page.waitForFunction(()=>/Buy\/sell dollars, \d+ recent swaps/.test(document.querySelector('#positionsList').innerText));
  const text=await page.locator('#positionsList').innerText();assert.match(text,/buys \$1,?0?\d*\.?\d* \(10\)|buys \$[\d.,K]+ \(10\)/);assert.match(text,/sells \$0\.00 \(0\)/);assert.match(text,/sell share 0%/);assert.ok(state.reads.transactions<=15,'bounded reads per refresh');assert.equal((await stored(page)).positions.length,1);
});
test('dominant selling in dollars plus a falling price closes the tracked position, marked without a fill',async t=>{
  const {page,state}=await open(t,'sell');await page.locator('[data-nav="positions"]').click();await page.waitForFunction(()=>/sell share 100%/.test(document.querySelector('#positionsList').innerText));
  state.market=[usdcPair({priceChange:{m5:-8},priceUsd:'.97'})];
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions.length===0,{},{timeout:30000});
  const note=(await stored(page)).history[0].note;assert.match(note,/Sell-dollar dominance: 100% of \$\d+/);assert.match(note,/no fill or executable quote is assumed/);
});
test('without a Helius key no flow requests are made and the position says a key is needed',async t=>{
  const context=await browser.newContext(process.env.BROWSER==='webkit'?devices['iPhone 13']:{viewport:{width:390,height:844},hasTouch:true,isMobile:true});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(15000);let flowCalls=0;
  await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?[usdcPair()]:[{chainId:'solana',tokenAddress:A}]}));
  await page.route(/https:\/\/(solana-rpc\.publicnode\.com|solana\.api\.onfinality\.io|api\.mainnet\.solana\.com)\//,route=>{const q=route.request().postDataJSON();if(q.method==='getSignaturesForAddress'||q.method==='getTransaction')flowCalls++;return route.fulfill({json:rpcResponse(q,chain)})});
  await page.route('https://api.jup.ag/**',route=>route.fulfill({json:jupiter(route.request().url())}));
  await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');await page.locator('[data-nav="discover"]').click();await page.locator('#candidates [data-review="'+A+'"]').click();await page.waitForFunction(()=>document.querySelector('#approveBtn')&&!document.querySelector('#approveBtn').disabled);await page.locator('#approveBtn').click();
  await page.locator('[data-nav="positions"]').click();assert.match(await page.locator('#positionsList').innerText(),/needs a Helius key/);await page.waitForTimeout(1500);assert.equal(flowCalls,0);
});
