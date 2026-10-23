(function(root){
'use strict';
// Token-2022 mint extension review. A token passes only when every extension is on the benign allowlist or is present
// but inert. Anything risky, mutable by an authority, or unrecognised blocks it. This reads the mint only; it says nothing about swap-level behaviour.
var SYSTEM='11111111111111111111111111111111';
var ALLOWED={metadataPointer:1,tokenMetadata:1,groupPointer:1,groupMemberPointer:1,tokenGroup:1,tokenGroupMember:1,mintCloseAuthority:1};
var ALWAYS_BLOCKED={
  nonTransferable:'Tokens cannot be transferred, so they cannot be sold.',
  pausableConfig:'An authority can pause all transfers.',
  confidentialTransferMint:'Confidential transfers hide balances and transfer amounts.',
  confidentialTransferFeeConfig:'Confidential transfer fees are configured.',
  confidentialMintBurn:'Confidential mint/burn is enabled.',
  scaledUiAmountConfig:'Displayed balances are scaled by an authority-controlled multiplier.',
  interestBearingConfig:'Displayed balances follow an authority-controlled rate.'
};
function unset(v){return v===null||v===undefined||v===''||v===SYSTEM}
function short(k){k=String(k||'');return k.length>10?k.slice(0,4)+'…'+k.slice(-4):k}
function feeBps(f){return f&&typeof f==='object'&&Number.isFinite(Number(f.transferFeeBasisPoints))?Number(f.transferFeeBasisPoints):null}
// extensions: the parsed list from getAccountInfo (jsonParsed) for a Token-2022 mint. freezeAuthority: the mint's freeze authority.
function review(extensions,freezeAuthority){
  if(!Array.isArray(extensions))return {status:'UNKNOWN',reason:'RPC did not return a parsed extension list.',allowed:[],blocked:[]};
  var allowed=[],blocked=[];
  extensions.forEach(function(e){
    var name=e&&typeof e.extension==='string'?e.extension:null,s=e&&e.state&&typeof e.state==='object'?e.state:{};
    function block(reason){blocked.push({extension:name||'unknown',reason:reason})}
    if(!name)return block('Extension entry could not be read.');
    if(ALLOWED[name])return allowed.push(name);
    if(ALWAYS_BLOCKED[name])return block(ALWAYS_BLOCKED[name]);
    if(name==='permanentDelegate')return unset(s.delegate)?allowed.push(name+' (unset)'):block('Permanent delegate '+short(s.delegate)+' can move or burn any holder\'s tokens.');
    if(name==='transferHook')return unset(s.programId)&&unset(s.authority)?allowed.push(name+' (unset)'):block('A transfer hook program'+(unset(s.programId)?' can be set later by '+short(s.authority):' '+short(s.programId)+' runs on every transfer')+'.');
    if(name==='transferFeeConfig'){
      var a=feeBps(s.olderTransferFee),b=feeBps(s.newerTransferFee);
      if(a===null||b===null)return block('Transfer fee settings could not be read.');
      if(a>0||b>0)return block('Every transfer pays a '+Math.max(a,b)/100+'% fee.');
      if(!unset(s.transferFeeConfigAuthority))return block('A fee authority '+short(s.transferFeeConfigAuthority)+' can set a transfer fee later.');
      return allowed.push(name+' (zero, locked)');
    }
    if(name==='defaultAccountState'){
      if(s.accountState==='frozen')return block('New token accounts start frozen.');
      return unset(freezeAuthority)?allowed.push(name+' (initialized)'):block('The freeze authority can change the default account state.');
    }
    block('Unrecognised extension, treated as unsafe.');
  });
  return {status:blocked.length?'BLOCKED':'PASS',reason:blocked.length?blocked.map(function(x){return x.extension+': '+x.reason}).join(' '):'',allowed:allowed,blocked:blocked};
}
var api={review:review,ALLOWED:Object.keys(ALLOWED)};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftToken2022=api;
})(typeof globalThis!=='undefined'?globalThis:window);
