'use strict';
// Paper broker. Nothing here signs or sends a transaction. A fill is priced against the live curve as it stands
// `latencyMs` after the decision, so price moves during detection, submission and landing count against the bot.
// Costs: pump's fee from the curve (protocol + creator bps of the latest trade), a tip and a priority fee per landed
// leg, and the priority fee for a leg that lands but reverts. The tracked curve never contains our paper buy, so a sell
// is quoted on the live reserves plus the SOL we put in and minus the tokens we still hold (ownS / remainingTokens).
// Without that, a sell would lose our own price impact a second time.
const { buyQuote, sellQuote, price, lamports, sol } = require('./curve');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class PaperBroker {
  constructor({ cfg, tracker, risk, log, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms), rng }) {
    this.cfg = cfg;
    this.tracker = tracker;
    this.risk = risk;
    this.log = log;
    this.now = now;
    this.schedule = schedule;
    this.rng = rng || mulberry32(cfg.seed == null ? Date.now() : cfg.seed);
    this.positions = new Map();
    this.seq = 0;
    this.recent = [];
  }

  _remember(rec) { this.recent.unshift(rec); this.recent.length = Math.min(this.recent.length, 100); }

  // decision: { sizeSol, reasons, flags }, features: snapshot at decision time.
  // The caller reserves the risk slot (risk.reserve) before any async check, so concurrent candidates cannot exceed maxOpen.
  open(m, decision, features) {
    const E = this.cfg.entry;
    const id = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const decidedAt = this.now();
    m.pending = true;
    this.schedule(() => this._fillBuy(id, m, decision, features, decidedAt), E.latencyMs);
    return id;
  }

  _fillBuy(id, m, decision, features, decidedAt) {
    const E = this.cfg.entry;
    m.pending = false;
    const at = this.now();
    const fail = (reason, costSol) => {
      this.risk.release();
      const rec = { kind: 'entry_failed', id, mint: m.mint, symbol: m.symbol, decidedAt, at, reason, sizeSol: decision.sizeSol, costsSol: costSol, pnlSol: -costSol };
      this.log('trades', rec);
      this._remember(rec);
      if (costSol > 0) this.risk.charge(costSol);
      return null;
    };
    if (m.completed) return fail('curve completed before the fill', 0);
    const spot = price(m.curve);
    if (spot === null) return fail('no curve price at fill time', 0);
    const moved = features.price ? (spot / features.price - 1) * 100 : 0;
    if (moved > E.buySlippagePct) return fail(`price rose ${moved.toFixed(1)}% before the fill (slippage limit ${E.buySlippagePct}%)`, E.priorityFeeSol);
    if (this.rng() < E.failRate) return fail('transaction did not land (simulated)', 0);
    const q = buyQuote(m.curve, lamports(decision.sizeSol), m.feeBps);
    if (q.tokens <= 0n) return fail('curve returned no tokens', E.priorityFeeSol);
    const tokensWhole = Number(q.tokens) / 1e6;
    const pos = {
      id, mint: m.mint, symbol: m.symbol, name: m.name,
      decidedAt, openedAt: at,
      sizeSol: decision.sizeSol,
      tokens: q.tokens, remainingTokens: q.tokens,
      ownS: q.net, // SOL (lamports) our buy added to the curve, net of pump's fee
      entryPrice: decision.sizeSol / tokensWhole, // effective, pump fee included
      decisionPrice: features.price, fillSpot: spot, slippageAtFillPct: moved,
      costsSol: E.tipSol + E.priorityFeeSol,
      proceedsSol: 0,
      peak: spot,
      takeProfitDone: false, closing: false,
      legs: [{ side: 'buy', at, sol: decision.sizeSol, tokens: q.tokens.toString(), spot }],
      reasons: decision.reasons, flags: decision.flags, features,
    };
    m.position = pos;
    this.positions.set(m.mint, pos);
    return pos;
  }

  // exit: { reason, fraction, takeProfit }
  close(pos, exit, attempt = 1) {
    if (!pos || (pos.closing && attempt === 1)) return;
    pos.closing = true;
    const m = this.tracker.mints.get(pos.mint);
    const decisionSpot = m ? price(m.curve) : null;
    this.schedule(() => this._fillSell(pos, exit, attempt, decisionSpot), this.cfg.exit.latencyMs);
  }

  _fillSell(pos, exit, attempt, decisionSpot) {
    const X = this.cfg.exit, E = this.cfg.entry;
    const m = this.tracker.mints.get(pos.mint);
    const at = this.now();
    const last = attempt >= X.maxSellAttempts;
    const tokens = exit.fraction >= 1 ? pos.remainingTokens : (pos.remainingTokens * BigInt(Math.round(exit.fraction * 1e6))) / 1000000n;
    let lamportsOut, spot, note = '';
    if (!m || m.completed) {
      // After completion the coin trades on PumpSwap, which this bot does not price: use the last curve price less a haircut.
      const lastPrice = m ? price(m.curve) : pos.peak;
      spot = lastPrice * (1 - X.completeHaircutPct / 100);
      lamportsOut = lamports((Number(tokens) / 1e6) * spot * (1 - Number(m ? m.feeBps : 125n) / 10000));
      note = 'priced after completion with haircut';
    } else {
      spot = price(m.curve);
      const drop = decisionSpot ? (1 - spot / decisionSpot) * 100 : 0;
      // A sell beyond its slippage limit reverts; the retry uses a wider limit, and the last attempt fills at any price.
      if (!last && drop > X.slippagePct) return this._retrySell(pos, exit, attempt, `price fell ${drop.toFixed(1)}% before the sell landed`);
      if (!last && this.rng() < E.failRate) return this._retrySell(pos, exit, attempt, 'sell did not land (simulated)', true);
      const withUs = { vS: m.curve.vS + pos.ownS, vT: m.curve.vT - pos.remainingTokens };
      if (withUs.vT <= 0n) withUs.vT = m.curve.vT; // cannot happen on a real curve; fall back to the live reserves
      const q = sellQuote(withUs, tokens, m.feeBps);
      lamportsOut = q.lamports;
      pos.ownS = pos.ownS > q.gross ? pos.ownS - q.gross : 0n;
      if (last && drop > X.slippagePct) note = `filled at any price on attempt ${attempt}`;
    }
    pos.remainingTokens -= tokens;
    pos.proceedsSol += sol(lamportsOut);
    pos.costsSol += E.tipSol + E.priorityFeeSol;
    pos.legs.push({ side: 'sell', at, reason: exit.reason, attempt, tokens: tokens.toString(), sol: sol(lamportsOut), spot, note });
    pos.closing = false;
    if (exit.takeProfit) { pos.takeProfitDone = true; pos.peak = spot; }
    if (pos.remainingTokens <= 0n) this._finish(pos, exit.reason, at);
  }

  _retrySell(pos, exit, attempt, why, noCost) {
    if (!noCost) pos.costsSol += this.cfg.entry.priorityFeeSol; // reverted transaction still pays its priority fee
    pos.legs.push({ side: 'sell_failed', at: this.now(), reason: why, attempt });
    this.close(pos, exit, attempt + 1);
  }

  _finish(pos, reason, at) {
    this.positions.delete(pos.mint);
    const m = this.tracker.mints.get(pos.mint);
    if (m) m.position = null;
    const pnlSol = pos.proceedsSol - pos.sizeSol - pos.costsSol;
    const rec = {
      kind: 'trade', id: pos.id, mint: pos.mint, symbol: pos.symbol, name: pos.name,
      decidedAt: pos.decidedAt, openedAt: pos.openedAt, closedAt: at, holdS: (at - pos.openedAt) / 1000,
      sizeSol: pos.sizeSol, proceedsSol: pos.proceedsSol, costsSol: pos.costsSol, pnlSol, pnlPct: (pnlSol / pos.sizeSol) * 100,
      entryPrice: pos.entryPrice, decisionPrice: pos.decisionPrice, slippageAtFillPct: pos.slippageAtFillPct,
      exitReason: reason, legs: pos.legs, reasons: pos.reasons, flags: pos.flags, features: pos.features,
    };
    this.log('trades', rec);
    this._remember(rec);
    this.risk.closed(pnlSol);
  }
}

module.exports = { PaperBroker, mulberry32 };
