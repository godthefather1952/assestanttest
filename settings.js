(function(){
'use strict';
var K=NightshiftKeys,HELIUS='https://mainnet.helius-rpc.com/',WSOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function $(s){return document.querySelector(s)}
function say(text,bad){var e=$('#keyStatus');e.textContent=text;e.className='notice'+(bad?' bad':'')}
function renderState(){var k=K.read();$('#heliusState').textContent=K.mask(k.helius);$('#jupiterState').textContent=K.mask(k.jupiter)}
function show(){document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('on',v.id==='settings')});document.querySelectorAll('[data-nav]').forEach(function(b){b.classList.remove('on')});renderState();scrollTo(0,0)}
function call(url,init){var c=new AbortController(),t=setTimeout(function(){c.abort()},9000);init=Object.assign({credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:c.signal},init);return fetch(url,init).finally(function(){clearTimeout(t)})}
function verdict(name,res,ok){return res.status===401||res.status===403?name+': key rejected (HTTP '+res.status+'). Check you copied it correctly.':res.status===429?name+': rate limited (HTTP 429). The key may still be valid; try again shortly.':!res.ok?name+': unexpected HTTP '+res.status+'.':ok?name+': OK.':name+': reached the provider but the reply was not as expected.'}
function failure(name,e){return name+': could not connect ('+(e&&e.name==='AbortError'?'timed out':'network or browser block')+').'}
// Tests use typed values when present, otherwise the saved keys. Keys are never echoed back.
function testKeys(){
  var typed={},k=K.read(),lines=[];
  try{typed.helius=K.normalize('helius',$('#heliusInput').value);typed.jupiter=K.normalize('jupiter',$('#jupiterInput').value)}catch(e){say(e.message,true);return}
  var helius=typed.helius||k.helius,jupiter=typed.jupiter||k.jupiter;
  if(!helius&&!jupiter){say('Enter a key or save one first.',true);return}
  say('Testing…');
  var jobs=[];
  if(helius)jobs.push(call(HELIUS+'?api-key='+encodeURIComponent(helius),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[WSOL,{encoding:'base64'}]})}).then(function(r){return r.ok?r.json().then(function(j){return verdict('Helius',r,!!(j&&j.result&&j.result.value))},function(){return verdict('Helius',r,false)}):verdict('Helius',r,false)},function(e){return failure('Helius',e)}));
  if(jupiter)jobs.push(call('https://api.jup.ag/swap/v2/order?inputMint='+WSOL+'&outputMint='+USDC+'&amount=1000000',{method:'GET',headers:{Accept:'application/json','x-api-key':jupiter}}).then(function(r){return r.ok?r.json().then(function(j){return verdict('Jupiter',r,!!(j&&/^\d+$/.test(String(j.outAmount))))},function(){return verdict('Jupiter',r,false)}):verdict('Jupiter',r,false)},function(e){return failure('Jupiter',e)}));
  Promise.all(jobs).then(function(r){var bad=r.some(function(x){return !/: OK\.$/.test(x)});say(r.join(' '),bad)});
}
function save(){
  try{K.save({helius:$('#heliusInput').value,jupiter:$('#jupiterInput').value})}catch(e){say(e.message,true);return}
  $('#heliusInput').value='';$('#jupiterInput').value='';renderState();say('Saved in this browser. Reloading…');setTimeout(function(){location.reload()},400);
}
function remove(){if(!confirm('Remove the saved keys from this browser? The scanner will use the public providers again.'))return;K.clear();renderState();say('Keys removed. Reloading…');setTimeout(function(){location.reload()},400)}
$('#settingsBtn').onclick=show;$('#saveKeys').onclick=save;$('#testKeys').onclick=testKeys;$('#removeKeys').onclick=remove;
$('#keysForm').onsubmit=function(e){e.preventDefault();save()};
})();
