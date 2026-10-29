'use strict';
// Risk limits and kill switch. Entries need every check to pass; exits are never blocked.

function dayOf(t) { return new Date(t).toISOString().slice(0, 10); }

class Risk {
  constructor(cfg, { now = Date.now, killFile = null, fs = require('node:fs') } = {}) {
    this.cfg = cfg.risk;
    this.now = now;
    this.killFile = killFile;
    this.fs = fs;
    this.killed = false;
    this.killReason = '';
    this.feedHealthy = false;
    this.open = 0; // open positions plus entries in flight
    this.entries = []; // entry times in the last hour
    this.day = dayOf(now());
    this.dailyPnl = 0;
    this.lossStreak = 0;
    this.pausedUntil = 0;
  }

  _roll(t) {
    const d = dayOf(t);
    if (d !== this.day) { this.day = d; this.dailyPnl = 0; }
    this.entries = this.entries.filter((x) => t - x < 3600000);
  }

  killFileExists() {
    try { return !!(this.killFile && this.fs.existsSync(this.killFile)); } catch (e) { return false; }
  }

  canEnter() {
    const t = this.now();
    this._roll(t);
    if (this.killed) return { ok: false, reason: 'kill switch on' + (this.killReason ? ': ' + this.killReason : '') };
    if (this.killFileExists()) return { ok: false, reason: 'kill switch on: KILL file present' };
    if (!this.feedHealthy) return { ok: false, reason: 'feed not healthy' };
    if (this.open >= this.cfg.maxOpen) return { ok: false, reason: `${this.cfg.maxOpen} positions open` };
    if (this.entries.length >= this.cfg.maxEntriesPerHour) return { ok: false, reason: `${this.cfg.maxEntriesPerHour} entries in the last hour` };
    if (this.dailyPnl <= -this.cfg.dailyLossSol) return { ok: false, reason: `daily loss limit ${this.cfg.dailyLossSol} SOL reached` };
    if (t < this.pausedUntil) return { ok: false, reason: `paused after ${this.cfg.maxConsecutiveLosses} losses in a row until ${new Date(this.pausedUntil).toISOString()}` };
    return { ok: true };
  }

  reserve() { this.open++; this.entries.push(this.now()); }
  release() { this.open = Math.max(0, this.open - 1); }

  closed(pnlSol) {
    const t = this.now();
    this._roll(t);
    this.release();
    this.dailyPnl += pnlSol;
    if (pnlSol < 0) {
      this.lossStreak++;
      if (this.lossStreak >= this.cfg.maxConsecutiveLosses) { this.pausedUntil = t + this.cfg.lossPauseMin * 60000; this.lossStreak = 0; }
    } else this.lossStreak = 0;
  }

  // A cost with no position behind it (a reverted entry's priority fee) counts toward the daily loss, not the loss streak.
  charge(sol) { this._roll(this.now()); this.dailyPnl -= sol; }

  kill(reason) { this.killed = true; this.killReason = reason || 'manual'; }
  resume() { this.killed = false; this.killReason = ''; this.pausedUntil = 0; }

  status() {
    const t = this.now();
    this._roll(t);
    const c = this.canEnter();
    return { entriesAllowed: c.ok, blockedBy: c.ok ? null : c.reason, open: this.open, entriesLastHour: this.entries.length, day: this.day, dailyPnlSol: this.dailyPnl, lossStreak: this.lossStreak, pausedUntil: this.pausedUntil || null, killed: this.killed || this.killFileExists() };
  }
}

module.exports = { Risk, dayOf };
