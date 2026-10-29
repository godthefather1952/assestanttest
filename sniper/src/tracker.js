'use strict';
// Keeps the state of every pump curve launched since the bot started, built only from decoded events: reserves, per-wallet
// balances from curve trades, the launch-block cluster, snipers, dev sells and a price trail. Tokens created before the
// bot started are ignored, which bounds memory.
const { price } = require('./curve');

const PUMP_SUFFIX = /pump$/;
const SOL_LIKE_QUOTES = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP', // native mint (Token-2022), treated as SOL by pump-fees
]);
const DEFAULT_VS = 30_000_000_000n; // 30 SOL virtual, used only if a launch is detected without a CreateEvent
const DEFAULT_VT = 1_073_000_000_000_000n;
const DEFAULT_SUPPLY = 1_000_000_000_000_000n;

function nameKey(name, symbol) {
  const n = String(name || '').trim().toLowerCase(), s = String(symbol || '').trim().toLowerCase();
  return n || s ? n + '|' + s : null;
}

class Tracker {
  constructor({ now = Date.now, maxSamples = 4000, sniperSlots = 2, onLaunch, onComplete } = {}) {
    this.now = now;
    this.maxSamples = maxSamples;
    this.sniperSlots = sniperSlots;
    this.onLaunch = onLaunch || (() => {});
    this.onComplete = onComplete || (() => {});
    this.mints = new Map();
    this.stats = { creates: 0, createsFromFallback: 0, trades: 0, completes: 0, ignoredTrades: 0, decodeErrors: 0, nonSolCurves: 0 };
  }

  // ctx: { slot, signature, receivedAt, hasCreateIx }
  handle(events, ctx) {
    const touched = new Set();
    const createdHere = new Set();
    for (const ev of events) {
      if (ev.type === 'DecodeError') { this.stats.decodeErrors++; continue; }
      if (ev.type === 'CreateEvent') {
        const m = this._launch(ev.data, ctx, true);
        if (m) { touched.add(m.mint); createdHere.add(m.mint); }
      } else if (ev.type === 'TradeEvent') {
        let m = this.mints.get(ev.data.mint);
        // Fallback when the transaction created the coin but no CreateEvent was decoded: the creator's first trade
        // still identifies the launch (name and symbol stay unknown, so the copycat check cannot run).
        if (!m && ctx.hasCreateIx && !createdHere.has(ev.data.mint)) m = this._launchFromTrade(ev.data, ctx);
        if (!m) { this.stats.ignoredTrades++; continue; }
        this._trade(m, ev.data, ctx);
        touched.add(m.mint);
      } else if (ev.type === 'CompleteEvent') {
        const m = this.mints.get(ev.data.mint);
        if (m) { this._complete(m, ctx.receivedAt); touched.add(m.mint); }
      }
    }
    return [...touched];
  }

  _launch(d, ctx, fromEvent) {
    if (this.mints.has(d.mint)) return null;
    const quote = d.quote_mint || '11111111111111111111111111111111';
    const solLike = SOL_LIKE_QUOTES.has(quote);
    if (!solLike) this.stats.nonSolCurves++;
    const vS = fromEvent ? (d.virtual_sol_reserves || d.virtual_quote_reserves || DEFAULT_VS) : DEFAULT_VS;
    const vT = fromEvent ? (d.virtual_token_reserves || DEFAULT_VT) : DEFAULT_VT;
    const m = {
      mint: d.mint,
      name: fromEvent ? d.name : null,
      symbol: fromEvent ? d.symbol : null,
      uri: fromEvent ? d.uri : null,
      creator: d.creator,
      devWallets: new Set([d.creator, d.user].filter(Boolean)),
      hasCreateEvent: fromEvent,
      createdSlot: ctx.slot,
      createdAt: ctx.receivedAt,
      supply: fromEvent && d.token_total_supply ? d.token_total_supply : (d.is_mayhem_mode || d.mayhem_mode ? 2n * DEFAULT_SUPPLY : DEFAULT_SUPPLY),
      mayhem: !!(d.is_mayhem_mode || d.mayhem_mode),
      tokenProgram: d.token_program || null,
      quoteMint: quote,
      solLike,
      launch: { vS, vT },
      curve: { vS, vT, realS: 0n, realT: fromEvent ? d.real_token_reserves : null },
      feeBps: 125n,
      trades: 0, buys: 0, sells: 0, solVolume: 0n,
      balances: new Map(),
      firstBuySlot: new Map(),
      block0: new Set(),
      snipers: new Set(),
      organic: new Set(),
      devSoldAt: null, linkedSoldAt: null,
      completed: false, completedAt: null,
      lastTradeAt: ctx.receivedAt,
      samples: [],
      decision: null, nextCheckpoint: 0, pending: false, position: null, outcome: null,
      mintSuffixPump: PUMP_SUFFIX.test(d.mint),
      nameKey: fromEvent ? nameKey(d.name, d.symbol) : null,
    };
    this.mints.set(m.mint, m);
    this.stats.creates++;
    if (!fromEvent) this.stats.createsFromFallback++;
    this._sample(m, ctx.receivedAt);
    this.onLaunch(m);
    return m;
  }

  _launchFromTrade(t, ctx) {
    if (!t.is_buy || !t.creator || t.user !== t.creator) return null;
    return this._launch({ mint: t.mint, creator: t.creator, user: t.user, quote_mint: t.quote_mint, mayhem_mode: t.mayhem_mode }, ctx, false);
  }

  _trade(m, t, ctx) {
    this.stats.trades++;
    const solLike = m.solLike;
    const vS = solLike ? (t.virtual_sol_reserves || t.virtual_quote_reserves) : t.virtual_quote_reserves;
    const realS = solLike ? (t.real_sol_reserves || t.real_quote_reserves) : t.real_quote_reserves;
    const amount = solLike ? (t.sol_amount || t.quote_amount) : t.quote_amount;
    if (vS > 0n && t.virtual_token_reserves > 0n) m.curve = { vS, vT: t.virtual_token_reserves, realS, realT: t.real_token_reserves };
    const fee = BigInt(t.fee_basis_points || 0n) + BigInt(t.creator_fee_basis_points || 0n);
    if (fee > 0n && fee < 10000n) m.feeBps = fee;
    m.trades++;
    m.solVolume += amount || 0n;
    m.lastTradeAt = ctx.receivedAt;
    const user = t.user, isDev = m.devWallets.has(user);
    const bal = m.balances.get(user) || 0n;
    if (t.is_buy) {
      m.buys++;
      m.balances.set(user, bal + t.token_amount);
      if (!m.firstBuySlot.has(user)) m.firstBuySlot.set(user, ctx.slot);
      if (ctx.slot <= m.createdSlot) m.block0.add(user);
      else if (!isDev && ctx.slot <= m.createdSlot + this.sniperSlots) m.snipers.add(user);
      // Organic demand: wallets that are not the dev, not in the launch block and not snipers.
      if (!isDev && !m.block0.has(user) && !m.snipers.has(user) && ctx.slot > m.createdSlot + this.sniperSlots) m.organic.add(user);
    } else {
      m.sells++;
      const next = bal - t.token_amount;
      m.balances.set(user, next > 0n ? next : 0n);
      if (isDev && m.devSoldAt === null) m.devSoldAt = ctx.receivedAt;
      if (!isDev && m.block0.has(user) && m.linkedSoldAt === null) m.linkedSoldAt = ctx.receivedAt;
    }
    if (t.real_token_reserves === 0n && !m.completed) this._complete(m, ctx.receivedAt);
    this._sample(m, ctx.receivedAt);
  }

  _complete(m, at) {
    if (m.completed) return;
    m.completed = true;
    m.completedAt = at;
    this.stats.completes++;
    this.onComplete(m);
  }

  _sample(m, at) {
    const p = price(m.curve);
    if (p === null) return;
    if (m.samples.length >= this.maxSamples) m.samples.splice(0, m.samples.length - this.maxSamples + 1);
    m.samples.push([at, p]);
  }

  // Snapshot used by the filters. Shares are of total supply; the bonding curve's own holdings never appear in
  // `balances` because they are not a trading wallet.
  features(m, now = this.now()) {
    const supply = Number(m.supply);
    const pct = (tokens) => (supply > 0 ? (Number(tokens) / supply) * 100 : 0);
    let block0Tokens = 0n;
    for (const w of m.block0) block0Tokens += m.balances.get(w) || 0n;
    for (const w of m.devWallets) if (!m.block0.has(w)) block0Tokens += m.balances.get(w) || 0n;
    let devTokens = 0n;
    for (const w of m.devWallets) devTokens += m.balances.get(w) || 0n;
    const top = [...m.balances.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, 10);
    const top10 = top.reduce((a, b) => a + b, 0n);
    const p = price(m.curve), p0 = price(m.launch);
    return {
      mint: m.mint, symbol: m.symbol, name: m.name, creator: m.creator,
      ageS: (now - m.createdAt) / 1000,
      hasCreateEvent: m.hasCreateEvent,
      solLike: m.solLike, quoteMint: m.quoteMint, mayhem: m.mayhem,
      solRaised: Number(m.curve.realS || 0n) / 1e9,
      price: p,
      multiple: p && p0 ? p / p0 : null,
      block0Pct: pct(block0Tokens),
      block0Wallets: m.block0.size,
      devPct: pct(devTokens),
      top10Pct: pct(top10),
      snipers: m.snipers.size,
      organicBuyers: m.organic.size,
      trades: m.trades, buys: m.buys, sells: m.sells,
      solPerTrade: m.trades ? Number(m.solVolume) / 1e9 / m.trades : 0,
      devSold: m.devSoldAt !== null,
      devSoldAt: m.devSoldAt,
      linkedSold: m.linkedSoldAt !== null,
      linkedSoldAt: m.linkedSoldAt,
      completed: m.completed,
      mintSuffixPump: m.mintSuffixPump,
      feeBps: Number(m.feeBps),
    };
  }

  delete(mint) { this.mints.delete(mint); }
}

module.exports = { Tracker, nameKey, SOL_LIKE_QUOTES };
