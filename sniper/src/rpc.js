'use strict';
// HTTP RPC reads used before a paper buy, and the optional metadata fetch. Read-only; no signing exists in this bot.
const path = require('node:path');
const Token2022 = require(path.join(__dirname, '..', '..', 'token2022.js')); // shared with the scanner page

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

async function post(url, body, timeoutMs, fetchImpl = fetch) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error('RPC ' + json.error.code + ': ' + String(json.error.message).slice(0, 120));
  return json.result;
}

// Same rules as the scanner: token program owner, mint and freeze authority null, Token-2022 extensions only from the
// benign allowlist. Fails closed: any read error is a rejection.
async function checkMint(httpUrl, mint, { timeoutMs = 3000, fetchImpl, commitment = 'processed' } = {}) {
  if (!httpUrl) return { ok: false, reason: 'RPC_HTTP_URL is not set' };
  let r;
  try { r = await post(httpUrl, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment }] }, timeoutMs, fetchImpl); } catch (e) { return { ok: false, reason: 'mint read failed: ' + e.message }; }
  const acc = r && r.value;
  if (!acc) return { ok: false, reason: 'mint account not found yet' };
  if (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022_PROGRAM) return { ok: false, reason: 'mint not owned by a token program' };
  const info = acc.data && acc.data.parsed && acc.data.parsed.type === 'mint' && acc.data.parsed.info;
  if (!info) return { ok: false, reason: 'mint did not parse' };
  if (info.mintAuthority !== null) return { ok: false, reason: 'mint authority enabled' };
  if (info.freezeAuthority !== null) return { ok: false, reason: 'freeze authority enabled' };
  if (acc.owner === TOKEN_2022_PROGRAM) {
    const t = Token2022.review(info.extensions, info.freezeAuthority);
    if (t.status !== 'PASS') return { ok: false, reason: 'Token-2022: ' + (t.reason || t.status) };
    return { ok: true, program: 'Token-2022', extensions: t.allowed };
  }
  return { ok: true, program: 'SPL Token' };
}

// Soft signal only (report: never gate on missing socials). Short timeout; any failure means "unknown".
// The URI is chosen by whoever launched the coin, so only public https hostnames are fetched and redirects are refused.
function safeMetadataUrl(uri) {
  let u;
  try { u = new URL(uri); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null; // IP literals
  return u.href;
}

async function fetchSocials(uri, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const url = safeMetadataUrl(uri);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 100000) return null;
    const j = JSON.parse(text);
    const pick = (k) => (typeof j[k] === 'string' && j[k].trim() ? j[k].trim().slice(0, 200) : null);
    return { telegram: pick('telegram'), twitter: pick('twitter'), website: pick('website') };
  } catch (e) { return null; }
}

module.exports = { checkMint, fetchSocials, safeMetadataUrl, TOKEN_PROGRAM, TOKEN_2022_PROGRAM };
