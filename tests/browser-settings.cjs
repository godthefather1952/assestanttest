// Run from repo root: node --test tests/browser-settings.cjs  (BROWSER=webkit for iPhone-emulated WebKit; not real iPhone Safari)
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium,webkit,devices}=require('playwright');
const {serve,pair,rpcResponse,jupiter,A}=require('./browser-fixtures.cjs');
const HK='11111111-2222-3333-4444-555555555555',JK='jup_ABCDEFGHIJKLMNOP1234';
let browser,server,origin;
before(async()=>{({server,origin}=await serve());const engine=process.env.BROWSER==='webkit'?webkit:chromium;browser=await engine.launch({headless:true,...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})})});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
async function open(t,{heliusStatus=200,jupStatus=200}={}){
  const context=await browser.newContext(process.env.BROWSER==='webkit'?devices['iPhone 13']:{viewport:{width:390,height:844},hasTouch:true,isMobile:true});t.after(()=>context.close());
  const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  const seen={helius:[],publicRpc:[],jup:[]};
  await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?[pair()]:[{chainId:'solana',tokenAddress:A}]}));
  await page.route('https://mainnet.helius-rpc.com/**',route=>{seen.helius.push(route.request().url());return heliusStatus===200?route.fulfill({json:rpcResponse(route.request().postDataJSON())}):route.fulfill({status:heliusStatus,json:{error:'x'}})});
  await page.route(/https:\/\/(solana-rpc\.publicnode\.com|solana\.api\.onfinality\.io|api\.mainnet\.solana\.com)\//,route=>{seen.publicRpc.push(route.request().url());return route.fulfill({status:429,json:{error:'rate'}})});
  await page.route('https://api.jup.ag/**',route=>{seen.jup.push(route.request().headers());return jupStatus===200?route.fulfill({json:jupiter(route.request().url())}):route.fulfill({status:jupStatus,json:{error:'x'}})});
  await page.goto(origin);await page.locator('#settingsBtn').click();
  return {page,seen};
}
const stored=page=>page.evaluate(()=>localStorage.getItem('nightshift_keys_v1'));
test('invalid keys are rejected with a clear message and nothing is stored',async t=>{const {page}=await open(t);await page.locator('#heliusInput').fill('not a key!!');await page.locator('#saveKeys').click();assert.match(await page.locator('#keyStatus').innerText(),/Helius key format is not recognised/);assert.equal(await stored(page),null);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)});
test('Test keys reports OK for working keys without saving or echoing them',async t=>{const {page}=await open(t);await page.locator('#heliusInput').fill(HK);await page.locator('#jupiterInput').fill(JK);await page.locator('#testKeys').click();await page.waitForFunction(()=>/Jupiter: OK/.test(document.querySelector('#keyStatus').innerText));const text=await page.locator('#keyStatus').innerText();assert.match(text,/Helius: OK/);assert.doesNotMatch(text,new RegExp(HK+'|'+JK));assert.equal(await stored(page),null)});
test('Test keys explains rejected and rate-limited keys',async t=>{for(const [status,re] of [[401,/key rejected \(HTTP 401\)/],[429,/rate limited/]]){const {page}=await open(t,{heliusStatus:status});await page.locator('#heliusInput').fill(HK);await page.locator('#testKeys').click();await page.waitForFunction(()=>/Helius:/.test(document.querySelector('#keyStatus').innerText));assert.match(await page.locator('#keyStatus').innerText(),re)}});
test('save reloads the page; the key is then used, kept out of backups, and removable',async t=>{
  const {page,seen}=await open(t);await page.locator('#heliusInput').fill('https://mainnet.helius-rpc.com/?api-key='+HK);await page.locator('#jupiterInput').fill(JK);
  await Promise.all([page.waitForEvent('load'),page.locator('#saveKeys').click()]);
  assert.deepEqual(JSON.parse(await stored(page)),{helius:HK,jupiter:JK});seen.publicRpc.length=0;seen.helius.length=0;seen.jup.length=0;
  await page.waitForFunction(()=>Number(document.querySelector('#scanned').textContent)>0);assert.match(await page.locator('#dataHealth').innerText(),/Helius key active · Jupiter key active/);assert.doesNotMatch(await page.locator('#dataHealth').innerText(),new RegExp(HK+'|'+JK));
  await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');assert.ok(seen.helius.length>0&&seen.helius.every(u=>u.includes('api-key='+HK)));assert.equal(seen.publicRpc.length,0,'public fallbacks untouched while Helius works');
  await page.locator('#candidates').scrollIntoViewIfNeeded().catch(()=>{});await page.locator('[data-nav="discover"]').click();await page.locator('#candidates [data-review="'+A+'"]').click();await page.waitForFunction(()=>/ROUTE AVAILABLE/.test(document.querySelector('#review').innerText));assert.ok(seen.jup.length>0&&seen.jup.every(h=>h['x-api-key']===JK));await page.locator('#close').click();
  await page.locator('[data-nav="history"]').click();const dl=page.waitForEvent('download');await page.locator('#export').click();const backup=fs.readFileSync(await (await dl).path(),'utf8');assert.doesNotMatch(backup,new RegExp(HK+'|'+JK));assert.doesNotMatch(await page.evaluate(()=>localStorage.getItem('nightshift_v1')),new RegExp(HK+'|'+JK));
  await page.locator('#settingsBtn').click();assert.match(await page.locator('#heliusState').innerText(),/saved \(ending 5555\)/);assert.equal(await page.locator('#heliusInput').inputValue(),'');assert.equal(await page.locator('#heliusInput').getAttribute('type'),'password');
  page.once('dialog',d=>d.accept());await Promise.all([page.waitForEvent('load'),page.locator('#removeKeys').click()]);assert.equal(await stored(page),null);await page.waitForFunction(()=>Number(document.querySelector('#scanned').textContent)>0);assert.doesNotMatch(await page.locator('#dataHealth').innerText(),/key active/);
});
