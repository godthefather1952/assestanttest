(function(root){
'use strict';
// Optional provider keys entered on the Settings screen. They live only in this browser's localStorage under their own key:
// never in the repo, never in the state backup/export, never shown again after saving (only the last four characters).
var STORE='nightshift_keys_v1',HELIUS=/^[A-Za-z0-9-]{16,64}$/,JUPITER=/^[A-Za-z0-9_-]{16,128}$/;
function storage(){try{return root.localStorage||null}catch(e){return null}}
// Accepts the bare key, or a pasted Helius URL containing api-key=…
function normalize(kind,value){
  var v=String(value||'').trim();if(!v)return '';
  if(kind==='helius'){var m=/[?&]api-key=([^&\s]+)/i.exec(v);if(m)v=decodeURIComponent(m[1])}
  if(!(kind==='helius'?HELIUS:JUPITER).test(v))throw Error((kind==='helius'?'Helius':'Jupiter')+' key format is not recognised. Paste only the key.');
  return v;
}
function read(){
  try{var s=storage(),raw=s&&s.getItem(STORE);if(!raw)return {helius:'',jupiter:''};var o=JSON.parse(raw);
    return {helius:typeof o.helius==='string'&&HELIUS.test(o.helius)?o.helius:'',jupiter:typeof o.jupiter==='string'&&JUPITER.test(o.jupiter)?o.jupiter:''}}
  catch(e){return {helius:'',jupiter:''}}
}
// A blank field keeps the existing key; use clear() to remove.
function save(update){
  update=update||{};var cur=read(),next={helius:normalize('helius',update.helius)||cur.helius,jupiter:normalize('jupiter',update.jupiter)||cur.jupiter},s=storage();
  if(!s)throw Error('Browser storage is unavailable, so keys cannot be saved (private browsing?).');
  try{s.setItem(STORE,JSON.stringify(next))}catch(e){throw Error('Browser storage is unavailable or full, so keys cannot be saved.')}
  return next;
}
function clear(){try{var s=storage();if(s)s.removeItem(STORE)}catch(e){}}
function mask(key){return key?'saved (ending '+key.slice(-4)+')':'not set'}
var cfg=root.NightshiftConfig=root.NightshiftConfig||{},stored=read();
if(stored.helius&&!cfg.heliusKey)cfg.heliusKey=stored.helius;
if(stored.jupiter&&!cfg.quoteKey)cfg.quoteKey=stored.jupiter;
var api={read:read,save:save,clear:clear,mask:mask,normalize:normalize,STORE:STORE};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NightshiftKeys=api;
})(typeof globalThis!=='undefined'?globalThis:window);
