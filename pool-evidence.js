(function(root){
'use strict';
var TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
var ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Program ids and account layouts are the only pool formats this scanner trusts. Offsets index into the raw pool account.
// A wrong offset cannot produce a pass: decoded mints must equal the market's mints and each vault must be an on-chain token account of that mint.
var PROGRAMS={
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':{dex:'raydium',name:'Raydium AMM v4',mintA:400,mintB:432,vaultA:336,vaultB:368},
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':{dex:'raydium',name:'Raydium CPMM',mintA:168,mintB:200,vaultA:72,vaultB:104},
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK':{dex:'raydium',name:'Raydium CLMM',mintA:73,mintB:105,vaultA:137,vaultB:169},
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':{dex:'orca',name:'Orca Whirlpool',mintA:101,mintB:181,vaultA:133,vaultB:213},
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':{dex:'meteora',name:'Meteora DLMM',mintA:88,mintB:120,vaultA:152,vaultB:184},
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':{dex:'pumpswap',name:'PumpSwap AMM',mintA:43,mintB:75,vaultA:139,vaultB:171}
};
// Recognised program ids whose layout has no validated adapter. They are reported as unsupported, never as verified.
var UNADAPTED={
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG':'Meteora DAMM v2',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB':'Meteora Dynamic AMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':'Pump.fun bonding curve'
};
// Own keys only, so an inherited name such as "constructor" never matches a program table.
function own(map,key){return Object.prototype.hasOwnProperty.call(map,key)?map[key]:undefined}
function base58(bytes){
  var n=0n,i;for(i=0;i<bytes.length;i++)n=(n<<8n)|BigInt(bytes[i]);
  var out='';while(n>0n){out=ALPHABET[Number(n%58n)]+out;n/=58n}
  for(i=0;i<bytes.length&&bytes[i]===0;i++)out='1'+out;
  return out;
}
function decodeBase64(text){
  var bin=atob(text),bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return bytes;
}
function keyAt(bytes,offset){return offset+32<=bytes.length?base58(bytes.subarray(offset,offset+32)):null}
// Decodes a pool account into its mints and vault addresses; returns null when the program or account is not a trusted layout.
function decodePool(owner,bytes){
  var layout=own(PROGRAMS,owner);if(!layout||!bytes)return null;
  var pool={program:owner,name:layout.name,dex:layout.dex,mintA:keyAt(bytes,layout.mintA),mintB:keyAt(bytes,layout.mintB),vaultA:keyAt(bytes,layout.vaultA),vaultB:keyAt(bytes,layout.vaultB)};
  return pool.mintA&&pool.mintB&&pool.vaultA&&pool.vaultB?pool:null;
}
function result(status,reason,extra){return Object.assign({status:status,reason:reason,stage:null,at:Date.now(),program:null,programName:null,pool:null,mints:null,vaults:[]},extra||{})}
function tokenProgram(owner){return owner===TOKEN_PROGRAM||owner===TOKEN_2022_PROGRAM}
// Verifies, from on-chain accounts, that the market's pool is owned by a known DEX program, references the expected mints and holds them in real token-account vaults.
// request(method, params) must return the RPC result ({value}). Bonding curves and unadapted programs are never verified.
async function verifyPool(request,pair,validAddress){
  var dex=String(pair&&pair.dexId||'').toLowerCase();
  if(dex==='pumpfun')return result('UNSUPPORTED','Bonding curve: no reserve/migration adapter is validated.',{stage:'program'});
  var address=pair&&pair.pairAddress,base=pair&&pair.baseToken&&pair.baseToken.address,quote=pair&&pair.quoteToken&&pair.quoteToken.address;
  if(!validAddress(address))return result('UNKNOWN','Market data supplied no valid pool address.',{stage:'program'});
  if(!validAddress(base)||!validAddress(quote))return result('UNKNOWN','Market data supplied no valid base/quote mints.',{stage:'program'});
  var account;
  try{account=(await request('getAccountInfo',[address,{encoding:'base64',commitment:'finalized'}])).value}catch(e){return result('UNKNOWN','Pool account unavailable: '+String(e&&e.message||e).slice(0,200),{stage:'program'})}
  if(!account)return result('FAILED','Pool account does not exist on-chain.',{pool:address,stage:'program'});
  var owner=account.owner;
  if(own(UNADAPTED,owner))return result('UNSUPPORTED',own(UNADAPTED,owner)+' is recognised but has no validated adapter.',{pool:address,program:owner,programName:own(UNADAPTED,owner),stage:'program'});
  var layout=own(PROGRAMS,owner);
  if(!layout)return result('FAILED','Pool account is owned by unrecognised program '+String(owner).slice(0,44)+'.',{pool:address,program:owner,stage:'program'});
  if(layout.dex!==dex)return result('FAILED','Pool program is '+layout.name+' but the market reports '+dex+'.',{pool:address,program:owner,programName:layout.name,stage:'program'});
  var bytes;try{bytes=decodeBase64(String(account.data&&account.data[0]||''))}catch(e){return result('FAILED','Pool account data could not be decoded.',{pool:address,program:owner,programName:layout.name,stage:'program'})}
  var decoded=decodePool(owner,bytes),shared={pool:address,program:owner,programName:layout.name,stage:'mints'};
  if(!decoded)return result('FAILED','Pool account is too short for the '+layout.name+' layout.',shared);
  var forward=decoded.mintA===base&&decoded.mintB===quote,reverse=decoded.mintA===quote&&decoded.mintB===base;
  if(!forward&&!reverse)return result('FAILED','Pool mints do not match the market base/quote mints.',shared);
  var expected=[{vault:decoded.vaultA,mint:decoded.mintA},{vault:decoded.vaultB,mint:decoded.mintB}];
  if(expected[0].vault===expected[1].vault)return result('FAILED','Pool lists the same vault twice.',shared);
  var accounts;shared=Object.assign({},shared,{stage:'vaults'});
  try{accounts=(await request('getMultipleAccounts',[[expected[0].vault,expected[1].vault],{encoding:'jsonParsed',commitment:'finalized'}])).value}catch(e){return result('UNKNOWN','Vault accounts unavailable: '+String(e&&e.message||e).slice(0,200),shared)}
  if(!Array.isArray(accounts)||accounts.length!==2)return result('FAILED','Vault lookup returned an unexpected shape.',shared);
  var vaults=[];
  for(var i=0;i<2;i++){
    var a=accounts[i],info=a&&a.data&&a.data.parsed&&a.data.parsed.info;
    if(!a||!tokenProgram(a.owner)||!a.data.parsed||a.data.parsed.type!=='account'||!info)return result('FAILED','Pool vault '+(i+1)+' is missing or not a token account.',shared);
    if(info.mint!==expected[i].mint)return result('FAILED','Pool vault '+(i+1)+' holds a different mint than the pool declares.',shared);
    if(info.state&&info.state!=='initialized')return result('FAILED','Pool vault '+(i+1)+' is '+info.state+'.',shared);
    var amount=info.tokenAmount&&info.tokenAmount.amount;
    if(typeof amount!=='string'||!/^\d+$/.test(amount))return result('FAILED','Pool vault '+(i+1)+' balance is invalid.',shared);
    vaults.push({address:expected[i].vault,mint:info.mint,authority:info.owner||null,amount:amount});
  }
  return result('VERIFIED','Pool program, mints and vaults match on-chain accounts.',Object.assign({},shared,{stage:null,mints:{base:base,quote:quote},vaults:vaults}));
}
// Top-10 concentration from the largest-account list. Raw counts every account; adjusted removes only vaults verified above,
// so it never discounts accounts it cannot prove are pool infrastructure. Shares are of total mint supply.
function concentration(holders,supply,infraAddresses){
  function top(list){var sum=list.map(function(h){return h.amount}).sort(function(a,b){return a>b?-1:a<b?1:0}).slice(0,10).reduce(function(a,b){return a+b},0n);return Number(sum*10000n/supply)/100}
  var parsed=holders.map(function(h){return {address:h.address,amount:BigInt(h.amount)}});
  var raw=top(parsed),infra=infraAddresses&&infraAddresses.length?infraAddresses:null;
  if(!infra)return {raw:raw,adjusted:null,excluded:[]};
  var excluded=parsed.filter(function(h){return infra.indexOf(h.address)>=0}).map(function(h){return h.address});
  return {raw:raw,adjusted:top(parsed.filter(function(h){return infra.indexOf(h.address)<0})),excluded:excluded};
}
var api={PROGRAMS:PROGRAMS,UNADAPTED:UNADAPTED,base58:base58,decodePool:decodePool,verifyPool:verifyPool,concentration:concentration};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftPools=api;
})(typeof globalThis!=='undefined'?globalThis:window);
