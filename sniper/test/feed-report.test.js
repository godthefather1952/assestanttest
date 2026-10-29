'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Feed } = require('../src/feed');
const { PUMP_PROGRAM } = require('../src/decode');
const { summarize, load, category } = require('../src/report');
const f = require('./fixtures/events.json');

class MockWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; MockWS.all.push(this); }
  send(x) { this.sent.push(JSON.parse(x)); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
  deliver(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeout = (fn, ms) => { t.timeouts.push({ fn, ms }); return t.timeouts.length; };
  t.clearTimeout = () => {};
  t.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return t.intervals.length; };
  t.clearInterval = () => {};
  return t;
}

const note = (slot, logs, err = null) => ({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot }, value: { signature: 'sig' + slot, err, logs } }, subscription: 7 } });

test('feed subscribes to pump logs, emits decoded events, skips failed transactions', () => {
  MockWS.all = [];
  let now = 1000;
  const feed = new Feed({ url: 'wss://rpc/?api-key=k', WebSocketImpl: MockWS, now: () => now, timers: fakeTimers() });
  const got = [];
  feed.on('tx', (tx) => got.push(tx));
  feed.start();
  const ws = MockWS.all[0];
  ws.onopen();
  assert.deepEqual(ws.sent[0], { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }] });
  assert.equal(feed.healthy(), false, 'not healthy until the subscription is confirmed');
  ws.deliver({ jsonrpc: '2.0', id: 1, result: 7 });
  assert.equal(feed.healthy(), true);
  const logs = [`Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: Create', 'Program data: ' + f.base64.CreateEvent, 'Program data: ' + f.base64.TradeEvent, `Program ${PUMP_PROGRAM} success`];
  ws.deliver(note(100, logs));
  ws.deliver(note(101, logs, { InstructionError: [0, 'Custom'] }));
  assert.equal(got.length, 1);
  assert.equal(got[0].slot, 100);
  assert.equal(got[0].hasCreateIx, true);
  assert.deepEqual(got[0].events.map((e) => e.type), ['CreateEvent', 'TradeEvent']);
  assert.equal(feed.state.failedTx, 1);
});

test('feed reconnects with backoff when messages stop or the socket closes, and reports a failed subscribe', () => {
  MockWS.all = [];
  let now = 0;
  const timers = fakeTimers();
  const feed = new Feed({ url: 'wss://rpc', WebSocketImpl: MockWS, now: () => now, timers, staleMs: 15000 });
  feed.start();
  MockWS.all[0].onopen();
  MockWS.all[0].deliver({ jsonrpc: '2.0', id: 1, result: 1 });
  now = 16000;
  timers.intervals[0].fn(); // watchdog
  assert.equal(feed.healthy(), false);
  assert.match(feed.state.lastError, /no message for 16s/);
  assert.equal(timers.timeouts.at(-1).ms, 1000, 'first retry after 1 s');
  timers.timeouts.at(-1).fn();
  assert.equal(MockWS.all.length, 2);
  MockWS.all[1].close(); // closed before opening: next retry waits longer
  assert.equal(timers.timeouts.at(-1).ms, 2000);
  timers.timeouts.at(-1).fn();
  MockWS.all[2].onopen();
  MockWS.all[2].deliver({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
  assert.match(feed.state.lastError, /subscribe failed: Method not found/);
  assert.equal(feed.healthy(), false);
});

test('report compares outcomes by decision and summarises paper trades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-report-'));
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dir, day));
  const w = (k, rows) => fs.writeFileSync(path.join(dir, day, k + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const mk = (action, reason, max, min, grad) => ({ action, reason, graduated: grad, marks: { 180: { maxMult: max, minMult: min, lastMult: 1 }, 600: { lastMult: 0.5 } } });
  w('outcomes', [mk('buy', '', 2.5, 0.9, true), mk('buy', '', 1.1, 0.4, false), mk('reject', 'copycat of an earlier coin (name and symbol)', 1.0, 0.3, false), mk('reject', 'too slow: 0.2 SOL raised', 1.2, 0.8, false), mk('blocked', 'risk: 3 positions open', 3, 1, false)]);
  w('trades', [{ kind: 'trade', pnlSol: 0.05, pnlPct: 20, costsSol: 0.003, holdS: 40, exitReason: 'take profit +100%' }, { kind: 'trade', pnlSol: -0.02, pnlPct: -8, costsSol: 0.002, holdS: 120, exitReason: 'time stop 120s' }, { kind: 'entry_failed', reason: 'price rose 13.0% before the fill', costsSol: 0.00002, pnlSol: -0.00002 }]);
  w('candidates', [{}, {}, {}]);
  const s = summarize(load(dir, 7));
  assert.equal(s.trades.n, 2);
  assert.equal(s.trades.wins, 1);
  assert.ok(Math.abs(s.trades.pnlSol - 0.03) < 1e-12);
  assert.equal(s.entryFailures.reasons['price rose N% before the fill'], 1);
  const bought = s.outcomes.find((o) => o.group === 'BOUGHT');
  assert.equal(bought.n, 2);
  assert.equal(bought.hit2x180Pct, 50);
  assert.equal(bought.fellHalf180Pct, 50);
  assert.equal(bought.graduatedPct, 50);
  assert.ok(s.outcomes.some((o) => o.group === 'rejected: copycat'));
  assert.ok(s.outcomes.some((o) => o.group === 'rejected: too slow'));
  assert.equal(category({ action: 'blocked' }), 'would buy, blocked by risk limit');
});

test('feed retries when the connection is refused (error without close) or hangs before opening', () => {
  MockWS.all = [];
  let now = 0;
  const timers = fakeTimers();
  const feed = new Feed({ url: 'wss://rpc', WebSocketImpl: MockWS, now: () => now, timers, staleMs: 15000 });
  feed.start();
  MockWS.all[0].onerror({ message: 'Received network error or non-101 status code.' }); // Node fires no close here
  assert.equal(feed.state.reconnects, 1);
  assert.equal(timers.timeouts.at(-1).ms, 1000);
  timers.timeouts.at(-1).fn();
  assert.equal(MockWS.all.length, 2);
  now = 16000; // second attempt never opens and never errors
  timers.intervals[0].fn();
  assert.match(feed.state.lastError, /could not connect within 15s/);
  assert.equal(feed.state.reconnects, 2);
  assert.equal(timers.timeouts.at(-1).ms, 2000);
});
