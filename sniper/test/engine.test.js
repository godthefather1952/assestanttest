'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, merge } = require('../src/config');
const { Store } = require('../src/store');
const { Sniper } = require('../src/engine');
const { Clock, Curve, key } = require('./sim');

function setup(over = {}, { mintCheck = async () => ({ ok: true }), rng = () => 0.99 } = {}) {
  const clock = new Clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-engine-'));
  const cfg = merge(DEFAULTS, merge({ dataDir: dir, entry: { failRate: 0.1 } }, over));
  const store = new Store(dir, { now: clock.now });
  const sniper = new Sniper({ cfg, store, now: clock.now, schedule: clock.schedule, rng, checkMint: mintCheck });
  sniper.setFeedHealthy(true);
  let slot = 5000;
  const send = (events, { slots = 1, createIx = false } = {}) => { slot += slots; sniper.onTx({ slot, receivedAt: clock.now(), hasCreateIx: createIx, events }); };
  const run = async (ms) => {
    const end = clock.t + ms;
    while (clock.t < end) { clock.advance(250, 250, () => sniper.tick()); await new Promise((r) => setImmediate(r)); }
  };
  const read = (kind) => {
    const out = [];
    for (const d of fs.readdirSync(dir).filter((x) => /^\d{4}-/.test(x))) {
      const f = path.join(dir, d, kind + '.jsonl');
      if (fs.existsSync(f)) out.push(...fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    }
    return out;
  };
  return { clock, cfg, sniper, send, run, read, dir };
}

// A launch: create plus the dev's buy in one transaction, then organic buyers several slots later.
async function launch(h, { name = 'Good', symbol = 'GOOD', devSol = 0.5, organic = 8, each = 0.3, bundle = [] } = {}) {
  const c = new Curve({ name, symbol });
  h.send([c.create(), c.buy(c.creator, devSol)], { createIx: true });
  for (const [w, s] of bundle) h.send([c.buy(w, s)], { slots: 0 }); // same slot as the launch
  for (let i = 0; i < organic; i++) { await h.run(400); h.send([c.buy(key('o' + i), each)], { slots: 5 }); }
  return c;
}

test('a clean launch is paper-bought at the first checkpoint, takes profit at 2x and exits the rest when the dev sells', async () => {
  const h = setup();
  const c = await launch(h);
  await h.run(5000);
  const cands = h.read('candidates');
  assert.equal(cands.length, 1);
  assert.equal(cands[0].action, 'buy');
  assert.equal(cands[0].checkpointS, 5);
  assert.ok(cands[0].features.block0Pct < 5, 'dev buy alone is under the 5% launch-block limit');
  assert.equal(h.sniper.broker.positions.size, 1, 'filled after the latency delay');
  for (let i = 0; i < 10; i++) h.send([c.buy(key('pump' + i), 2)], { slots: 2 });
  await h.run(2000);
  const pos = h.sniper.broker.positions.get(c.mint);
  assert.ok(pos.takeProfitDone, 'took profit at 2x');
  h.send([c.sell(c.creator, 1_000_000_000n)], { slots: 2 });
  await h.run(2000);
  const trades = h.read('trades').filter((t) => t.kind === 'trade');
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.exitReason, 'dev sold');
  assert.deepEqual(t.legs.map((l) => l.side), ['buy', 'sell', 'sell']);
  assert.match(t.legs[1].reason, /take profit/);
  assert.ok(t.pnlSol > 0, 'profitable: ' + t.pnlSol);
  assert.ok(Math.abs(t.costsSol - 3 * (0.001 + 0.00002)) < 1e-9, 'tip and priority fee on each of three legs');
  assert.equal(h.sniper.risk.open, 0);
});

test('a launch whose first block holds 10% or more of supply is rejected', async () => {
  const h = setup();
  await launch(h, { bundle: [[key('b1'), 1.5], [key('b2'), 1.5], [key('b3'), 1.5]] });
  await h.run(5000);
  const c = h.read('candidates')[0];
  assert.equal(c.action, 'reject');
  assert.match(c.reasons.at(-1), /launch-block cluster holds 1\d\.\d%/);
});

test('a copy of an earlier coin\'s name and symbol is rejected; the original is not', async () => {
  const h = setup();
  await launch(h, { name: 'Moon', symbol: 'MOON' });
  await launch(h, { name: ' moon ', symbol: 'Moon' });
  await h.run(6000);
  const byAction = h.read('candidates').map((c) => [c.symbol, c.action, c.reasons.at(-1) || '']);
  assert.equal(byAction[0][1], 'buy');
  assert.equal(byAction[1][1], 'reject');
  assert.match(byAction[1][2], /copycat/);
});

test('a slow launch waits through the checkpoints and is rejected at 60 s; its outcome is logged at 600 s and it is dropped', async () => {
  const h = setup();
  const c = await launch(h, { organic: 2 });
  await h.run(20000);
  assert.equal(h.read('candidates').length, 0, 'still waiting at 5 s and 15 s');
  await h.run(45000);
  const cand = h.read('candidates')[0];
  assert.equal(cand.checkpointS, 60);
  assert.match(cand.reasons.at(-1), /too slow/);
  for (let i = 0; i < 5; i++) h.send([c.buy(key('late' + i), 3)], { slots: 3 });
  await h.run(600000);
  const o = h.read('outcomes');
  assert.equal(o.length, 1);
  assert.equal(o[0].action, 'reject');
  assert.ok(o[0].marks['180'].maxMult > 1.5, 'later buying shows up in the outcome');
  assert.equal(h.sniper.tracker.mints.size, 0, 'finished tokens are dropped from memory');
});

test('risk limits block entries and the blocked decision is still logged for comparison', async () => {
  const h = setup({ risk: { maxOpen: 1 } });
  await launch(h, { name: 'A', symbol: 'A' });
  await launch(h, { name: 'B', symbol: 'B' });
  await h.run(6000);
  const actions = h.read('candidates').map((c) => c.action);
  assert.deepEqual(actions, ['buy', 'blocked']);
  assert.match(h.read('candidates')[1].reasons.at(-1), /risk: 1 positions open/);
});

test('a failed mint check rejects the buy and frees the risk slot', async () => {
  const h = setup({}, { mintCheck: async () => ({ ok: false, reason: 'freeze authority enabled' }) });
  await launch(h);
  await h.run(5000);
  const c = h.read('candidates')[0];
  assert.equal(c.action, 'reject');
  assert.match(c.reasons.at(-1), /mint check: freeze authority enabled/);
  assert.equal(h.sniper.risk.open, 0);
});

test('a price jump during the fill delay beyond the slippage limit fails the entry', async () => {
  const h = setup({ entry: { latencyMs: 2000 } });
  const c = await launch(h);
  for (let i = 0; i < 40 && !h.read('candidates').length; i++) await h.run(250);
  assert.equal(h.read('candidates')[0].action, 'buy');
  assert.equal(h.sniper.broker.positions.size, 0, 'decided, not yet filled');
  h.send([c.buy(key('whale'), 5)], { slots: 1 });
  await h.run(2000);
  const failed = h.read('trades').filter((t) => t.kind === 'entry_failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /price rose [\d.]+% before the fill \(slippage limit 12%\)/);
  assert.equal(h.sniper.risk.open, 0);
});

test('a position that goes nowhere is closed by the 120 s time stop at a small loss', async () => {
  const h = setup();
  await launch(h);
  await h.run(5000 + 121000 + 2000);
  const t = h.read('trades').find((x) => x.kind === 'trade');
  assert.equal(t.exitReason, 'time stop 120s');
  assert.ok(t.pnlPct < 0 && t.pnlPct > -5, 'fees, tips and nothing else: ' + t.pnlPct);
});

test('simulated landing failures: entries fail at the configured rate, sells are retried', async () => {
  const h = setup({}, { rng: () => 0.05 });
  await launch(h);
  await h.run(7000);
  const failed = h.read('trades').filter((t) => t.kind === 'entry_failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /did not land/);
});

test('launches seen without a CreateEvent are tracked but never bought; non-SOL curves are rejected', async () => {
  const h = setup();
  const c = new Curve({ name: 'X', symbol: 'X' });
  h.send([c.buy(c.creator, 0.5)], { createIx: true });
  const q = new Curve({ name: 'Q', symbol: 'Q', quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  h.send([q.create(), q.buy(q.creator, 0.5)], { createIx: true });
  await h.run(5500);
  const reasons = h.read('candidates').map((x) => x.reasons.at(-1));
  assert.equal(h.sniper.tracker.stats.createsFromFallback, 1);
  assert.ok(reasons.some((r) => /without CreateEvent/.test(r)));
  assert.ok(reasons.some((r) => /not SOL/.test(r)));
});

test('trades on coins launched before the bot started are ignored', () => {
  const h = setup();
  const old = new Curve();
  h.send([old.buy(key('x'), 1)]);
  assert.equal(h.sniper.tracker.mints.size, 0);
  assert.equal(h.sniper.tracker.stats.ignoredTrades, 1);
});

test('status reports totals, positions and decisions for the dashboard', async () => {
  const h = setup();
  await launch(h);
  await h.run(6000);
  const s = h.sniper.status({ healthy: true });
  assert.equal(s.mode, 'paper');
  assert.equal(s.positions.length, 1);
  assert.equal(s.totals.buys, 1);
  assert.equal(s.recentDecisions[0].action, 'buy');
});
