const {test}=require('node:test');
const assert=require('node:assert/strict');
const {liquidity,poolSupported,createRpc}=require('../scanner-data.js');
test('liquidity unknown is distinct from reported zero',()=>{
 for(const v of [undefined,null,'', ' ',false,NaN,Infinity,-1])assert.equal(liquidity({liquidity:{usd:v}}),null);
 assert.equal(liquidity({}),null);assert.equal(liquidity({liquidity:{usd:0}}),0);assert.equal(liquidity({liquidity:{usd:'10000'}}),10000);
});
test('supported pools exclude bonding curves and unknown markets',()=>{
 for(const dexId of ['raydium','orca','meteora','pumpswap'])assert.equal(poolSupported({dexId}),true);
 for(const dexId of ['pumpfun','unknown',undefined])assert.equal(poolSupported({dexId}),false);
});
test('RPC fallback, deduplication, cache expiry and cooldown',async()=>{
 let now=1000,calls=[];const rpc=createRpc(async(url)=>{calls.push(url);if(url==='https://a.example')throw Error('HTTP 429');return {result:{value:{ok:true}}}},{endpoints:['https://a.example','https://b.example'],now:()=>now,wait:async()=>{}});
 const p=rpc.request('getAccountInfo',['mint']);assert.equal(rpc.request('getAccountInfo',['mint']),p);await p;
 assert.deepEqual(calls,['https://a.example','https://b.example']);await rpc.request('getAccountInfo',['mint']);assert.equal(calls.length,2);
 await rpc.request('getAccountInfo',['other']);assert.deepEqual(calls,['https://a.example','https://b.example','https://b.example']);
 now+=61000;await rpc.request('getAccountInfo',['mint']);assert.equal(calls.length,5);
});
test('method-specific cooldown preserves working methods; errors remain actionable',async()=>{
 const rpc=createRpc(async(url,opt)=>{const method=JSON.parse(opt.body).method;if(method==='getTokenLargestAccounts')return {error:{code:-32601,message:'Method disabled'}};return {result:{value:{owner:'token'}}}},{endpoints:['https://a.example'],wait:async()=>{}});
 await assert.rejects(rpc.request('getTokenLargestAccounts',['mint']),/getTokenLargestAccounts unavailable.*Method disabled/);
 assert.ok((await rpc.request('getAccountInfo',['mint'])).value);
 await assert.rejects(rpc.request('getTokenLargestAccounts',['mint']),/cooldown/);
});
test('failed results are not cached as success and malformed responses fail closed',async()=>{
 const rpc=createRpc(async()=>({unexpected:true}),{endpoints:['https://a.example'],wait:async()=>{}});
 await assert.rejects(rpc.request('getAccountInfo',['mint']),/Malformed RPC response/);
});
