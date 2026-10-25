// Run with: NODE_PATH=<directory containing playwright> node tests/browser-smoke.cjs
const { chromium, webkit, devices }=require('playwright');
const fs=require('node:fs');const assert=require('node:assert/strict');const {serve,pair:mkPair,rpcResponse,jupiter,A}=require('./browser-fixtures.cjs');
(async()=>{
 const {server,origin}=await serve();
 let browser;
 try{const engine=process.env.BROWSER==='webkit'?webkit:chromium;browser=await engine.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH&&engine===chromium?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});const page=await browser.newPage(engine===webkit?devices['iPhone 13']:{viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const pair=mkPair();
 await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?[pair]:[{chainId:'solana',tokenAddress:A}]}));
 await page.route('https://solana-rpc.publicnode.com/**',route=>route.fulfill({json:rpcResponse(route.request().postDataJSON())}));
 await page.route('https://api.jup.ag/**',route=>route.fulfill({json:jupiter(route.request().url())}));
 await page.goto(origin);assert.match(await page.locator('#dataHealth').innerText(),/Scanner v2\.5/);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');
 await page.locator('#heroDeck [data-review]').click();await page.locator('#approveBtn').waitFor();assert.equal(await page.locator('#approveBtn').isEnabled(),true);assert.match(await page.locator('#review').innerText(),/Pool vaults[\s\S]*?VERIFIED/);await page.locator('#approveBtn').click();assert.equal(await page.locator('#posCount').innerText(),'1');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions.length),1);
 await page.locator('[data-nav="history"]').click();const download=page.waitForEvent('download');await page.locator('#export').click();const path=await (await download).path();const backup=JSON.parse(fs.readFileSync(path));assert.equal(backup.version,2);assert.ok(backup.state.snapshots[A]);assert.equal(backup.state.positions.length,1);
 page.on('dialog',d=>d.accept());await page.locator('#importFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.waitForFunction(()=>document.querySelector('#toast').textContent.startsWith('Backup restored'));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('nightshift_v1')).state.positions.length),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('PASS: mobile browser scan, on-chain pool evidence, review, approve, full export/restore, CSP script loading, no page errors or horizontal overflow');
 }finally{if(browser)await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
