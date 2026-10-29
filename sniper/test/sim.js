'use strict';
// Test helpers: a fake clock and scheduler, and a pump curve simulator that emits events shaped like decoded logs.
const crypto = require('node:crypto');
const { base58 } = require('../src/decode');

const ZERO = '11111111111111111111111111111111';
let n = 0;
function key(tag = '') {
  const b = crypto.createHash('sha256').update('k' + n++ + tag).digest();
  return base58(b);
}
function pumpMint() { let k; do { k = key('m'); } while (k.length !== 44); return k.slice(0, 40) + 'pump'; }

class Clock {
  constructor(start = 1_800_000_000_000) { this.t = start; this.timers = []; }
  now = () => this.t;
  schedule = (fn, ms) => { this.timers.push({ at: this.t + ms, fn }); };
  // Moves time forward in steps, running due timers and the given per-step callback (the engine tick).
  advance(ms, step = 250, onStep) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      this.runDue();
      if (onStep) onStep();
    }
  }
  runDue() {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      if (!this.timers.length || this.timers[0].at > this.t) return;
      this.timers.shift().fn();
    }
  }
}

class Curve {
  constructor({ mint = pumpMint(), creator = key('c'), name = 'Test', symbol = 'TST', feeBps = 95n, creatorFeeBps = 30n, quote = ZERO } = {}) {
    this.mint = mint; this.creator = creator; this.name = name; this.symbol = symbol;
    this.vS = 30_000_000_000n; this.vT = 1_073_000_000_000_000n; this.realS = 0n; this.realT = 793_100_000_000_000n;
    this.feeBps = feeBps; this.creatorFeeBps = creatorFeeBps; this.quote = quote;
  }
  create() {
    return { type: 'CreateEvent', data: { name: this.name, symbol: this.symbol, uri: 'https://example.com/m.json', mint: this.mint, bonding_curve: key('bc'), user: this.creator, creator: this.creator, timestamp: 0n, virtual_token_reserves: this.vT, virtual_sol_reserves: this.vS, real_token_reserves: this.realT, token_total_supply: 1_000_000_000_000_000n, token_program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: this.quote, virtual_quote_reserves: this.vS, creator_fee_bps: 0n, is_holder_reward: false, depth: 0 } };
  }
  _trade(user, isBuy, sol, tokens) {
    return { type: 'TradeEvent', data: { mint: this.mint, sol_amount: sol, token_amount: tokens, is_buy: isBuy, user, timestamp: 0n, virtual_sol_reserves: this.vS, virtual_token_reserves: this.vT, real_sol_reserves: this.realS, real_token_reserves: this.realT, fee_recipient: ZERO, fee_basis_points: this.feeBps, fee: 0n, creator: this.creator, creator_fee_basis_points: this.creatorFeeBps, creator_fee: 0n, track_volume: true, total_unclaimed_tokens: 0n, total_claimed_tokens: 0n, current_sol_volume: 0n, last_update_timestamp: 0n, ix_name: isBuy ? 'buy' : 'sell', mayhem_mode: false, cashback_fee_basis_points: 0n, cashback: 0n, buyback_fee_basis_points: 0n, buyback_fee: 0n, shareholders: [], quote_mint: this.quote, quote_amount: sol, virtual_quote_reserves: this.vS, real_quote_reserves: this.realS, holder_rewards_bps: 0n, holder_rewards: 0n, creator_fee_unclaimed: 0n, quote_transfer_fee: 0n } };
  }
  buy(user, solAmount) {
    const sol = BigInt(Math.round(solAmount * 1e9));
    let tokens = (sol * this.vT) / (this.vS + sol);
    if (tokens > this.realT) tokens = this.realT;
    this.vS += sol; this.vT -= tokens; this.realS += sol; this.realT -= tokens;
    return this._trade(user, true, sol, tokens);
  }
  sell(user, tokens) {
    const t = BigInt(tokens);
    const sol = (t * this.vS) / (this.vT + t);
    this.vS -= sol; this.vT += t; this.realS -= sol; this.realT += t;
    return this._trade(user, false, sol, t);
  }
  complete() { return { type: 'CompleteEvent', data: { user: ZERO, mint: this.mint, bonding_curve: ZERO, timestamp: 0n, quote_mint: this.quote } }; }
}

module.exports = { Clock, Curve, key, pumpMint, ZERO };
