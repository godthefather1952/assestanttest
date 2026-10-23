// Shared mocked-provider fixtures for the browser tests. No test here contacts a real provider or a wallet.
const http=require('node:http');
const fs=require('node:fs');
const {pair:basePair,poolAccount,vaultAccount,A,B,C,POOL}=require('./harness.cjs');
const Pools=require('../pool-evidence.js');
const kp=n=>Pools.base58(Uint8Array.from({length:32},(_,i)=>i===0?n:7));
const POOL2=kp(2),VB1=kp(3),VB2=kp(4);
const FILES=['app.js','config.js','keys.js','settings.js','scanner-data.js','pool-evidence.js','sell-quote.js'];
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function serve(){
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);const file=FILES.includes(name)?name:'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file))}).listen(0,'127.0.0.1');
 return new Promise(r=>server.once('listening',()=>r({server,origin:'http://127.0.0.1:'+server.address().port})));
}
function pair(address=A,symbol='FIRST',over={}){return {...basePair(address),pairAddress:address===B?POOL2:POOL,baseToken:{address,symbol,name:symbol},...over}}
// Mint, pool and vault accounts that agree with pair(); override pieces to model bad on-chain evidence.
function rpcResponse(q,over={}){
 const method=q.method;let result;
 if(method==='getAccountInfo')result=q.params[1].encoding==='base64'?{value:'pool' in over?over.pool:q.params[0]===POOL2?poolAccount(B,C,VB1,VB2):poolAccount()}:{value:{owner:C,data:{parsed:{type:'mint',info:{supply:'100',decimals:6,mintAuthority:null,freezeAuthority:null}}}}};
 else if(method==='getMultipleAccounts')result={value:over.vaults||(q.params[0][0]===VB1?[vaultAccount(B),vaultAccount(C)]:[vaultAccount(A),vaultAccount(C)])};
 else result={value:[{address:C,amount:'20'}]};
 return {jsonrpc:'2.0',id:1,result};
}
function jupiter(url,over={}){const u=new URL(url);const amount=u.searchParams.get('amount');return {inputMint:u.searchParams.get('inputMint'),outputMint:USDC,inAmount:amount,outAmount:String(Math.floor(Number(amount)*0.98)),otherAmountThreshold:String(Math.floor(Number(amount)*0.97)),slippageBps:100,priceImpact:-1.5,feeBps:10,router:'metis',routePlan:[{swapInfo:{label:'Raydium'}}],...over}}
module.exports={serve,pair,rpcResponse,jupiter,A,B,C,POOL,POOL2,USDC,vaultAccount,poolAccount};
