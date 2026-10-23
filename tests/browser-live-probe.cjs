// Read-only live RPC probe from the deployed origin. No wallet or transactions.
// Reports observations; provider success is not asserted or guaranteed.
const {chromium,webkit,devices}=require('playwright');
const fs=require('node:fs');
(async()=>{
 const engine=process.env.BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(process.env.USE_ENV_PROXY==='1'&&process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY}}:{}),...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
 const report={startedAt:new Date().toISOString(),engine:process.env.BROWSER||'chromium',browserVersion:browser.version(),origin:process.env.SCANNER_URL||'https://godthefather1952.github.io/assestanttest/',network:[],console:[]};
 try{
  const page=await browser.newPage(engine===webkit?devices['iPhone 13']:{viewport:{width:390,height:844}});
  page.on('request',r=>{if(/publicnode|onfinality|mainnet.solana/.test(r.url()))report.network.push({event:'request',at:Date.now(),url:r.url(),method:r.method(),rpc:r.postDataJSON()?.method})});
  page.on('response',r=>{if(/publicnode|onfinality|mainnet.solana/.test(r.url()))report.network.push({event:'response',at:Date.now(),url:r.url(),status:r.status(),allowOrigin:r.headers()['access-control-allow-origin']||null})});
  page.on('requestfailed',r=>report.network.push({event:'failed',at:Date.now(),url:r.url(),error:r.failure()?.errorText}));
  page.on('console',m=>{if(m.type()==='error')report.console.push(m.text())});
  await page.addInitScript(()=>{window.probeCsp=[];document.addEventListener('securitypolicyviolation',e=>window.probeCsp.push({directive:e.effectiveDirective,blocked:e.blockedURI}))});
  // Isolate RPC probes from discovery traffic. RPC requests themselves are never mocked.
  await page.route('https://api.dexscreener.com/**',route=>route.fulfill({json:route.request().url().includes('/search')?{pairs:[]}:[]}));
  const response=await page.goto(report.origin,{timeout:45000});report.documentStatus=response.status();report.finalUrl=page.url();
  await page.waitForFunction(()=>!!window.NightshiftData,{timeout:20000});report.version=await page.locator('#dataHealth').innerText();
  report.rounds=await page.evaluate(async()=>{
   const calls=[];const rpc=NightshiftData.createRpc(async(url,opt)=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),9000);try{const r=await fetch(url,{...opt,signal:c.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});if(!r.ok)throw Error(r.status);return await r.json()}finally{clearTimeout(timer)}});
   const params=['So11111111111111111111111111111111111111112',{commitment:'finalized'}];
   async function run(label,method,p){const start=Date.now();try{const value=await rpc.request(method,p);calls.push({label,method,start,end:Date.now(),ok:true,valuePresent:value.value!=null})}catch(e){calls.push({label,method,start,end:Date.now(),ok:false,error:e.message})}}
   await run('initial mint','getAccountInfo',[params[0],{encoding:'jsonParsed',commitment:'finalized'}]);
   await run('initial holders','getTokenLargestAccounts',params);
   await run('immediate repeat (cache or cooldown)','getTokenLargestAccounts',params);
   window.probeRpc=rpc;return {calls,health:rpc.health};
  });
  console.log('Initial live probe:',JSON.stringify(report.rounds));
  // A real 61-second interval verifies retry eligibility; it does not imply provider recovery.
  await page.waitForTimeout(61000);
  report.recovery=await page.evaluate(async()=>{const rpc=window.probeRpc,start=Date.now();try{const value=await rpc.request('getTokenLargestAccounts',['So11111111111111111111111111111111111111112',{commitment:'finalized'}]);return {start,end:Date.now(),ok:true,valuePresent:value.value!=null,health:rpc.health}}catch(e){return {start,end:Date.now(),ok:false,error:e.message,health:rpc.health}}});
  report.cspViolations=await page.evaluate(()=>window.probeCsp);report.completedAt=new Date().toISOString();
 }catch(e){report.blocker=e.message;process.exitCode=1}finally{fs.writeFileSync(process.env.PROBE_OUTPUT||'/tmp/nightshift-live-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close()}
})();
