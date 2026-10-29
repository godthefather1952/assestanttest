'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, load, redactUrl, merge } = require('../src/config');
const { evaluate } = require('../src/filters');
const exits = require('../src/exits');
const { Risk } = require('../src/risk');
const { Store } = require('../src/store');
const { checkMint, safeMetadataUrl } = require('../src/rpc');
const { startServer, tokenOk } = require('../src/server');

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
const good = (over = {}) => ({ mint: 'X', solLike: true, quoteMint: '111', hasCreateEvent: true, completed: false, devSold: false, block0Pct: 2, top10Pct: 12, snipers: 3, solRaised: 4, organicBuyers: 9, mintSuffixPump: true, price: 1e-7, ...over });
const ctx = (over = {}) => ({ copycat: false, creator: { launches7d: 0, priorGraduations: 0, quietDays: Infinity }, lastCheckpoint: false, ...over });

test('filters: a clean launch is bought at the configured size', () => {
  const d = evaluate(good(), ctx(), cfg);
  assert.equal(d.action, 'buy');
  assert.equal(d.sizeSol, 0.25);
});

test('filters: each hard rule rejects with its own reason', () => {
  const cases = [
    [good({ solLike: false }), ctx(), /not SOL/],
    [good({ hasCreateEvent: false }), ctx(), /without CreateEvent/],
    [good({ completed: true }), ctx(), /already complete/],
    [good(), ctx({ copycat: true }), /copycat/],
    [good({ devSold: true }), ctx(), /dev already sold/],
    [good({ block0Pct: 10 }), ctx(), /launch-block cluster holds 10.0%/],
    [good({ top10Pct: 31 }), ctx(), /top 10 wallets hold 31.0%/],
    [good({ snipers: 21 }), ctx(), /crowded: 21 snipers/],
    [good({ solRaised: 15.5 }), ctx(), /past the 15 SOL entry cap/],
  ];
  for (const [f, c, re] of cases) {
    const d = evaluate(f, c, cfg);
    assert.equal(d.action, 'reject', String(re));
    assert.match(d.reasons.at(-1), re);
  }
});

test('filters: size rules from the report (half at 5-10% launch-block cluster, half for busy creators, boost for quiet graduates)', () => {
  assert.equal(evaluate(good({ block0Pct: 7 }), ctx(), cfg).sizeSol, 0.125);
  assert.equal(evaluate(good(), ctx({ creator: { launches7d: 6, priorGraduations: 0, quietDays: 1 } }), cfg).sizeSol, 0.125);
  const boosted = evaluate(good(), ctx({ creator: { launches7d: 0, priorGraduations: 1, quietDays: 9 } }), cfg);
  assert.equal(boosted.sizeSol, 0.375);
  assert.match(boosted.flags.join(), /graduated a coin before/);
  const capped = evaluate(good(), ctx({ creator: { launches7d: 0, priorGraduations: 1, quietDays: 9 } }), merge(cfg, { entry: { sizeSol: 0.4 } }));
  assert.equal(capped.sizeSol, 0.5, 'never above maxSizeSol');
});

test('filters: slow launches wait, then are rejected at the last checkpoint', () => {
  const slow = good({ organicBuyers: 2, solRaised: 0.4 });
  assert.equal(evaluate(slow, ctx(), cfg).action, 'wait');
  const last = evaluate(slow, ctx({ lastCheckpoint: true }), cfg);
  assert.equal(last.action, 'reject');
  assert.match(last.reasons.at(-1), /too slow: 0.40 SOL raised .* 2 organic buyers/);
});

test('filters: rejects a size where tips and priority fees exceed 5% of the position', () => {
  const d = evaluate(good(), ctx(), merge(cfg, { entry: { sizeSol: 0.03, maxSizeSol: 0.5 } }));
  assert.equal(d.action, 'reject');
  assert.match(d.reasons.at(-1), /priority fees are 6.8% of a 0.03 SOL position/);
});

test('exits: wallet triggers come first, then completion, price rules, time stop', () => {
  const pos = { openedAt: 1000, entryPrice: 1, remainingTokens: 5n, takeProfitDone: false, peak: 1, closing: false };
  const f = (o = {}) => ({ devSoldAt: null, linkedSoldAt: null, completed: false, solRaised: 5, price: 1, ...o });
  assert.equal(exits.check(pos, f({ devSoldAt: 2000, price: 3 }), 3000, cfg).reason, 'dev sold');
  assert.equal(exits.check(pos, f({ devSoldAt: 500 }), 3000, cfg), null, 'a dev sale before entry does not trigger');
  assert.equal(exits.check(pos, f({ linkedSoldAt: 2000 }), 3000, cfg).reason, 'launch-block wallet sold');
  assert.match(exits.check(pos, f({ solRaised: 81 }), 3000, cfg).reason, /before completion/);
  assert.equal(exits.check(pos, f({ price: 0.69 }), 3000, cfg).reason, 'stop -30%');
  const tp = exits.check(pos, f({ price: 2.01 }), 3000, cfg);
  assert.equal(tp.fraction, 0.7);
  assert.ok(tp.takeProfit);
  assert.equal(exits.check({ ...pos, takeProfitDone: true, peak: 3 }, f({ price: 2.2 }), 3000, cfg).reason, 'trailing stop 25% from peak');
  assert.equal(exits.check(pos, f(), 1000 + 120000, cfg).reason, 'time stop 120s');
  assert.equal(exits.check({ ...pos, closing: true }, f({ price: 0.1 }), 3000, cfg), null, 'no second exit while one is in flight');
});

test('risk: caps, daily loss, loss streak pause, kill switch and KILL file', () => {
  let t = Date.parse('2026-10-29T12:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-risk-'));
  const r = new Risk(cfg, { now: () => t, killFile: path.join(dir, 'KILL') });
  assert.match(r.canEnter().reason, /feed not healthy/);
  r.feedHealthy = true;
  assert.ok(r.canEnter().ok);
  r.reserve(); r.reserve(); r.reserve();
  assert.match(r.canEnter().reason, /3 positions open/);
  r.closed(-0.3); r.closed(-0.3); r.closed(-0.3);
  assert.ok(r.canEnter().ok);
  r.charge(0.2);
  assert.match(r.canEnter().reason, /daily loss limit 1 SOL/);
  t += 86400000; // next UTC day resets the daily figure
  assert.ok(r.canEnter().ok);
  for (let i = 0; i < 8; i++) { r.reserve(); r.closed(-0.01); }
  assert.match(r.canEnter().reason, /paused after 8 losses/);
  t += 31 * 60000;
  assert.ok(r.canEnter().ok);
  r.kill('test');
  assert.match(r.canEnter().reason, /kill switch on: test/);
  r.resume();
  fs.writeFileSync(path.join(dir, 'KILL'), '');
  assert.match(r.canEnter().reason, /KILL file/);
});

test('store: first coin of a name is not a copycat; creator history counts only earlier launches', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-store-')));
  assert.equal(s.isCopycat('doge|doge', 1000, 24), false);
  assert.equal(s.isCopycat('doge|doge', 2000, 24), true);
  assert.equal(s.isCopycat('doge|doge', 1000 + 25 * 3600000, 24), false, 'outside the window it is a new original');
  const day = 86400000;
  s.recordLaunch('C', 0); s.recordGraduation('C', 1000); s.recordLaunch('C', 2 * day);
  const h = s.creatorHistory('C', 10 * day);
  assert.equal(h.launches7d, 0, 'the launch 8 days earlier is outside the 7-day count');
  assert.equal(s.creatorHistory('C', 5 * day).launches7d, 2);
  assert.equal(h.priorGraduations, 1);
  assert.equal(h.quietDays, 8);
  assert.equal(s.creatorHistory('nobody', 1).known, false);
});

test('config: keys come only from the environment; mode must be paper; URLs are redacted in output', () => {
  const c = load(null, { RPC_WS_URL: 'wss://mainnet.helius-rpc.com/?api-key=SECRET', RPC_HTTP_URL: 'https://x/?api-key=SECRET' });
  assert.equal(c.rpc.wsUrl, 'wss://mainnet.helius-rpc.com/?api-key=SECRET');
  assert.equal(redactUrl(c.rpc.wsUrl), 'wss://mainnet.helius-rpc.com?…');
  assert.ok(!redactUrl('https://rpc.example.com/SECRETKEY').includes('SECRET'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-cfg-'));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ mode: 'live' }));
  assert.throws(() => load(path.join(dir, 'c.json'), {}), /mode must be "paper"/);
});

test('mint check fails closed and applies the scanner\'s Token-2022 rules', async () => {
  const reply = (value) => async () => ({ ok: true, json: async () => ({ result: { value } }) });
  const mint = (info, owner = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') => ({ owner, data: { parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, ...info } } } });
  const meta = [{ extension: 'metadataPointer', state: {} }, { extension: 'tokenMetadata', state: {} }];
  assert.equal((await checkMint('https://rpc', 'M', { fetchImpl: reply(mint({ extensions: meta })) })).ok, true);
  assert.match((await checkMint('https://rpc', 'M', { fetchImpl: reply(mint({ extensions: [...meta, { extension: 'permanentDelegate', state: { delegate: 'GAhY6goNLmaQwDfYRMBLtbfSacSTdp3kyixmjLZXRq1q' } }] })) })).reason, /Permanent delegate/);
  assert.match((await checkMint('https://rpc', 'M', { fetchImpl: reply(mint({ mintAuthority: 'abc', extensions: meta })) })).reason, /mint authority enabled/);
  assert.match((await checkMint('https://rpc', 'M', { fetchImpl: reply(mint({}, 'Other111')) })).reason, /not owned by a token program/);
  assert.match((await checkMint('https://rpc', 'M', { fetchImpl: async () => { throw new Error('boom'); } })).reason, /mint read failed: boom/);
  assert.match((await checkMint(null, 'M')).reason, /RPC_HTTP_URL/);
});

test('metadata URLs from coin creators are limited to public https hosts', () => {
  assert.ok(safeMetadataUrl('https://ipfs.io/ipfs/Qm'));
  for (const bad of ['http://ipfs.io/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://metadata.google.internal/x', 'https://user:pw@ipfs.io/x', 'https://ipfs.io:8443/x', 'file:///etc/passwd', 'nonsense'])
    assert.equal(safeMetadataUrl(bad), null, bad);
});

test('dashboard: refuses a public bind without a token; API needs the token when set', async () => {
  assert.throws(() => startServer({ host: '0.0.0.0', port: 0, token: null }, {}), /without DASHBOARD_TOKEN/);
  assert.equal(tokenOk({ headers: { 'x-dashboard-token': 'abc' } }, 'abc'), true);
  assert.equal(tokenOk({ headers: {} }, 'abc'), false);
  let killed = null;
  const server = startServer({ host: '127.0.0.1', port: 0, token: 'tok' }, { getStatus: () => ({ ok: 1 }), kill: (r) => { killed = r; }, resume: () => {} });
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/status', { headers: { 'x-dashboard-token': 'tok' } })).json(), { ok: 1 });
  assert.equal((await fetch(base + '/api/kill', { method: 'POST', headers: { 'x-dashboard-token': 'tok' } })).status, 200);
  assert.equal(killed, 'dashboard');
  assert.equal((await fetch(base + '/')).status, 200, 'the page itself loads; it asks for the token');
  server.close();
});
