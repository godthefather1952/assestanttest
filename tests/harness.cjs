const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app.js', 'utf8');
const A = 'So11111111111111111111111111111111111111112';
const B = '11111111111111111111111111111111';
const C = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const POOL = 'Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3';
function harness(raw=null) {
 const elements = new Map(); let stored=raw, fail=false;
 const document = {hidden:false, querySelector(s){if(!elements.has(s))elements.set(s,{textContent:'',innerHTML:'',dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},querySelectorAll(){return []}});return elements.get(s)},querySelectorAll(){return []}};
 const ctx = vm.createContext({NightshiftData:require('../scanner-data.js'),NightshiftPools:require('../pool-evidence.js'),NightshiftQuotes:require('../sell-quote.js'),document,localStorage:{getItem(){return stored},setItem(k,v){if(fail)throw Error('quota');stored=v}},Date,URL,console,setTimeout(){return 1},clearTimeout(){},AbortController,scrollTo(){},fetch(){throw Error('Unexpected network')}});
 const cut = source.indexOf("$('#refresh').onclick=");
 vm.runInContext(source.slice(0,cut)+`globalThis.api={get S(){return S},set S(v){S=v},validAddress,choose,verify,evaluate,approve,drawReview,openReview,approvalReason,backup,decodeState,save,restoreBackup,monitorPositions,refreshPositions,evidenceLabel,fullEvidence,quoteFor,requestQuote,evaluateExit,setQuotes(f){quoteClient=f},quoteCache,safeImage,avatar,stalePositions,positionDayPnl,partialExit, setRpc(f){rpc=f},setPairs(f){pairs=f},setBusy(v){busy=v},get storageBlocked(){return storageBlocked},get activeReview(){return activeReview}};})();`,ctx);
 return {api:ctx.api,ctx,elements,stored:()=>stored,fail(v){fail=v}};
}
function pair(a=A){return {chainId:'solana',dexId:'raydium',pairAddress:POOL,baseToken:{address:a,symbol:'TEST',name:'Test'},quoteToken:{address:C,symbol:'USDC',name:'USD Coin'},priceUsd:'1',liquidity:{usd:200000},volume:{m5:10000,h1:20000},txns:{m5:{buys:95,sells:5}},priceChange:{m5:10},pairCreatedAt:Date.now()-600000};}
function verified(top=20,extra={}){const now=Date.now();return {ok:true,coreOk:true,mint:null,freeze:null,top,adjusted:null,excluded:[],decimals:6,coreAt:now,holdersAt:now,program:'SPL Token',pool:{status:'VERIFIED',reason:'ok',stage:null,at:now,program:'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',programName:'Raydium CPMM',pool:POOL,vaults:[]},...extra}}
function pos(a=A){return {address:a,symbol:'TEST',amount:10,entry:1,current:1,opened:Date.now(),lastPriceAt:Date.now(),stale:false}}
function rpcData(api,amounts=['20'],info={}){api.setRpc(async m=>m==='getAccountInfo'?{value:{owner:C,data:{parsed:{type:'mint',info:{supply:'100',mintAuthority:null,freezeAuthority:null,...info}}}}}:{value:amounts.map((amount,i)=>({address:[A,B,C][i],amount}))});}
const CPMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',VAULT_A='Fo1Wt8bQhH5fzXQ4EYZ6mK1zV9n1Z4zJ6xQ2dZ1aC8Vx',VAULT_B='5xot9PVkphiX2adznghwrAuxGs2zeWisNSxMW6hU6Hkj';
function key(a){let n=0n;for(const ch of a)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(ch));const out=[];while(n>0n){out.unshift(Number(n&255n));n>>=8n}while(out.length<32)out.unshift(0);return out}
function poolAccount(mint0=A,mint1=C,v0=VAULT_A,v1=VAULT_B){const b=new Uint8Array(637);[[168,mint0],[200,mint1],[72,v0],[104,v1]].forEach(([o,k])=>b.set(key(k),o));return {owner:CPMM,data:[Buffer.from(b).toString('base64'),'base64']}}
function vaultAccount(mint,amount='1000',owner=C){return {owner:C,data:{parsed:{type:'account',info:{mint,state:'initialized',owner:'AuthAuthAuthAuthAuthAuthAuthAuthAuthAuthAuth1',tokenAmount:{amount}}}}}}
module.exports={harness,pair,verified,pos,rpcData,A,B,C,POOL,CPMM,VAULT_A,VAULT_B,key,poolAccount,vaultAccount};
