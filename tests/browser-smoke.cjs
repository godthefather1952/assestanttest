// Run with: NODE_PATH=<directory containing playwright> node tests/browser-smoke.cjs
const { chromium }=require('playwright');
const http=require('node:http');const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const server=http.createServer((req,res)=>{const path=req.url.split('?')[0];const file=path==='/app.js'?'app.js':path==='/scanner-data.js'?'scanner-data.js':'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file))}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const A='So11111111111111111111111111111111111111112',C='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
 const pair={chainId:'solana',dexId:'raydium',baseToken:{address:A,symbol:'TEST',name:'Test'},priceUsd:'1',liquidity:{usd:200000},volume:{m5:10000,h1:20000},txns:{m5:{buys:95,sells:5}},priceChange:{m5:10},pairCreatedAt:Date.now()-600000};
 await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/tokens/')?[pair]:[{chainId:'solana',tokenAddress:A}]}));
 await page.route('https://solana-rpc.publicnode.com/**',route=>{const q=route.request().postDataJSON();return route.fulfill({json:{jsonrpc:'2.0',id:1,result:q.method==='getAccountInfo'?{value:{owner:C,data:{parsed:{type:'mint',info:{supply:'100',mintAuthority:null,freezeAuthority:null}}}}}:{value:[{address:C,amount:'20'}]}}})});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>document.querySelector('#ready').textContent==='1');
 await page.locator('#heroDeck [data-review]').click();await page.locator('#approveBtn').waitFor();assert.equal(await page.locator('#approveBtn').isEnabled(),true);assert.match(await page.locator('#review').innerText(),/Coverage 63%/);await page.locator('#approveBtn').click();assert.equal(await page.locator('#posCount').innerText(),'1');
 await page.locator('[data-nav="history"]').click();const download=page.waitForEvent('download');await page.locator('#export').click();const path=await (await download).path();const backup=JSON.parse(fs.readFileSync(path));assert.equal(backup.version,2);assert.ok(backup.state.snapshots[A]);assert.equal(backup.state.positions.length,1);
 page.on('dialog',d=>d.accept());await page.locator('#importFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.waitForFunction(()=>document.querySelector('#toast').textContent.startsWith('Backup restored'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('PASS: mobile browser scan, review, approve, full export/restore, CSP script loading, no page errors or horizontal overflow');
 }finally{if(browser)await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
