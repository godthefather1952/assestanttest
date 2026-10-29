'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/decode');
const curve = require('../src/curve');
const f = require('./fixtures/events.json');

const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const P = d.PUMP_PROGRAM;

test('decodes CreateEvent, TradeEvent and CompleteEvent exactly as Anchor encoded them from the official IDL', () => {
  for (const name of ['CreateEvent', 'TradeEvent', 'CompleteEvent']) {
    const ev = d.decodeEvent(Buffer.from(f.base64[name], 'base64'));
    assert.equal(ev.type, name);
    assert.deepEqual(norm(ev.data), f.expected[name], name);
  }
  // CreateEvent's own `name` field (the token name) must not be confused with the event type.
  assert.equal(d.decodeEvent(Buffer.from(f.base64.CreateEvent, 'base64')).data.name, 'Test Coin');
});

test('discriminators are Anchor event hashes, and the vendored IDL is the official program', () => {
  assert.equal(P, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  for (const e of d.IDL.events) assert.deepEqual([...d.anchorDiscriminator('event', e.name)], e.discriminator, e.name);
});

test('older, shorter event layouts decode with the missing trailing fields at their defaults', () => {
  for (const o of f.older.TradeEvent) {
    const ev = d.decodeEvent(Buffer.from(o.base64, 'base64'));
    assert.equal(ev.type, 'TradeEvent');
    assert.equal(ev.data.sol_amount, 1000000000n, 'leading fields intact for cut ' + o.cut);
    assert.equal(ev.data.quote_transfer_fee, 0n);
    if (o.cut >= 16) assert.equal(ev.data.creator_fee_unclaimed, 0n);
  }
  for (const o of f.older.CreateEvent) {
    const ev = d.decodeEvent(Buffer.from(o.base64, 'base64'));
    assert.equal(ev.data.symbol, 'TEST');
    assert.equal(ev.data.depth, 0);
  }
});

test('data that ends inside a field is rejected, not silently padded', () => {
  const full = Buffer.from(f.base64.TradeEvent, 'base64');
  assert.throws(() => d.decodeEvent(full.subarray(0, full.length - 3)), /ends inside field/);
  assert.equal(d.decodeEvent(Buffer.from('0011223344556677', 'hex')), null, 'unknown discriminator is ignored');
});

test('parseLogs reads Program data only while the pump program is executing', () => {
  const trade = 'Program data: ' + f.base64.TradeEvent;
  const logs = [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]',
    trade, // emitted by another program: must be ignored
    `Program ${P} invoke [2]`,
    'Program log: Instruction: Buy',
    trade,
    `Program ${P} consumed 50000 of 200000 compute units`,
    `Program ${P} success`,
    trade, // back in the router
    'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success',
    `Program ${P} invoke [1]`,
    'Program log: Instruction: CreateV2',
    'Program data: ' + f.base64.CreateEvent,
    'Program data: !!!not base64',
    `Program ${P} success`,
  ];
  const evs = d.parseLogs(logs);
  assert.deepEqual(evs.map((e) => e.type), ['TradeEvent', 'CreateEvent']);
});

test('curve math: price multiple is ((30 + SOL raised) / 30)^2, matching the report (10 SOL = 1.78x, 15 SOL = 2.25x)', () => {
  const k = 30_000_000_000n * 1_073_000_000_000_000n;
  const at = (s) => { const vS = 30_000_000_000n + BigInt(s * 1e9); return { vS, vT: k / vS }; };
  const p0 = curve.price(at(0));
  assert.ok(Math.abs(curve.price(at(10)) / p0 - 1.7778) < 0.001);
  assert.ok(Math.abs(curve.price(at(15)) / p0 - 2.25) < 0.001);
  assert.ok(Math.abs(curve.price(at(85.005)) / p0 - 14.70) < 0.01);
});

test('curve math: buy and sell quotes follow the SDK formulas, fees included', () => {
  const c = { vS: 30_000_000_000n, vT: 1_073_000_000_000_000n, realT: 793_100_000_000_000n };
  const q = curve.buyQuote(c, 1_000_000_000n, 125n);
  const net = ((1_000_000_000n - 1n) * 10000n) / 10125n;
  assert.equal(q.net, net);
  assert.equal(q.tokens, (net * c.vT) / (c.vS + net));
  const s = curve.sellQuote(c, q.tokens, 125n);
  const gross = (q.tokens * c.vS) / (c.vT + q.tokens);
  assert.equal(s.gross, gross);
  assert.equal(s.fee, (gross * 125n + 9999n) / 10000n);
  // Selling back into the curve as the buy left it returns the buy less the two fees (about 2.5%).
  const after = { vS: c.vS + q.net, vT: c.vT - q.tokens };
  const back = Number(curve.sellQuote(after, q.tokens, 125n).lamports) / 1e9;
  assert.ok(back > 0.97 && back < 0.98, String(back));
  // Selling into a curve that never saw the buy loses the price impact twice more: the error the broker must avoid.
  assert.ok(Number(s.lamports) / 1e9 < 0.93);
  assert.equal(curve.buyQuote(c, 1n, 125n).tokens, 0n);
  assert.equal(curve.buyQuote({ ...c, realT: 5n }, 1_000_000_000n, 125n).tokens, 5n, 'capped at real token reserves');
});
