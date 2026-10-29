'use strict';
// Ties the pieces together: feed events -> tracker -> checkpoint decisions -> paper broker -> exits, plus outcome tracking
// for every decision so the filters can be refit from data. Time and scheduling are injected so tests can run it offline.
const path = require('node:path');
const { Tracker } = require('./tracker');
const { evaluate } = require('./filters');
const exits = require('./exits');
const { Risk } = require('./risk');
const { PaperBroker } = require('./paper');

class Sniper {
  constructor({ cfg, store, now = Date.now, schedule, rng, checkMint, fetchSocials }) {
    this.cfg = cfg;
    this.store = store;
    this.now = now;
    this.checkMint = checkMint;
    this.fetchSocials = fetchSocials;
    this.startedAt = now();
    this.tracker = new Tracker({ now, maxSamples: cfg.outcomes.maxSamples, sniperSlots: cfg.filters.sniperSlots, onLaunch: (m) => this._onLaunch(m), onComplete: (m) => this._onComplete(m) });
    this.risk = new Risk(cfg, { now, killFile: path.join(cfg.dataDir, 'KILL') });
    this.totals = { decisions: 0, buys: 0, rejects: 0, blocked: 0, entryFailed: 0, trades: 0, wins: 0, pnlSol: 0, costsSol: 0 };
    this.recentDecisions = [];
    this.broker = new PaperBroker({ cfg, tracker: this.tracker, risk: this.risk, now, schedule, rng, log: (kind, rec) => this._log(kind, rec) });
    this.lastHousekeeping = now();
  }

  _log(kind, rec) {
    this.store.append(kind, rec);
    if (kind === 'trades') {
      if (rec.kind === 'entry_failed') { this.totals.entryFailed++; this.totals.pnlSol += rec.pnlSol; this.totals.costsSol += rec.costsSol; }
      if (rec.kind === 'trade') { this.totals.trades++; if (rec.pnlSol > 0) this.totals.wins++; this.totals.pnlSol += rec.pnlSol; this.totals.costsSol += rec.costsSol; }
    }
  }

  _onLaunch(m) {
    m.copycat = this.store.isCopycat(m.nameKey, m.createdAt, this.cfg.filters.copycatWindowH);
    m.creatorHistory = this.store.creatorHistory(m.creator, m.createdAt);
    this.store.recordLaunch(m.creator, m.createdAt);
    if (this.cfg.entry.fetchMetadata && this.fetchSocials && m.uri) {
      this.fetchSocials(m.uri).then((s) => { m.socials = s; }, () => {});
    }
  }

  _onComplete(m) {
    this.store.recordGraduation(m.creator, m.completedAt);
    if (m.outcome && !m.outcome.graduatedAt) m.outcome.graduatedAt = m.completedAt;
  }

  setFeedHealthy(ok) { this.risk.feedHealthy = !!ok; }

  onTx(tx) {
    const touched = this.tracker.handle(tx.events, tx);
    const now = this.now();
    for (const mint of touched) {
      const m = this.tracker.mints.get(mint);
      if (!m) continue;
      this._updateOutcome(m);
      if (m.position) this._checkExit(m, now);
    }
  }

  _checkExit(m, now) {
    const pos = m.position;
    if (!pos || pos.closing) return;
    const f = this.tracker.features(m, now);
    if (f.price !== null && f.price > pos.peak) pos.peak = f.price;
    const ex = exits.check(pos, f, now, this.cfg);
    if (ex) this.broker.close(pos, ex);
  }

  _updateOutcome(m) {
    const o = m.outcome;
    const s = m.samples[m.samples.length - 1];
    if (!o || !s) return;
    if (s[1] > o.max) { o.max = s[1]; o.maxAt = s[0]; }
    if (s[1] < o.min) { o.min = s[1]; o.minAt = s[0]; }
    o.last = s[1];
  }

  _record(m, f, action, reasons, flags, checkpointS, sizeSol) {
    const rec = { mint: m.mint, symbol: m.symbol, name: m.name, creator: m.creator, checkpointS, action, reasons, flags, sizeSol, creatorHistory: m.creatorHistory, copycat: !!m.copycat, socials: m.socials || null, features: f };
    this.store.append('candidates', rec);
    this.totals.decisions++;
    if (action === 'buy') this.totals.buys++; else if (action === 'blocked') this.totals.blocked++; else this.totals.rejects++;
    this.recentDecisions.unshift({ at: this.now(), mint: m.mint, symbol: m.symbol, checkpointS, action, reason: reasons[reasons.length - 1] || '', flags });
    this.recentDecisions.length = Math.min(this.recentDecisions.length, 100);
    m.decision = action;
    m.outcome = { decidedAt: this.now(), action, reason: reasons[reasons.length - 1] || '', checkpointS, ref: f.price, max: f.price, min: f.price, last: f.price, maxAt: null, minAt: null, marks: {}, graduatedAt: m.completed ? m.completedAt : null, solRaised: f.solRaised, block0Pct: f.block0Pct, top10Pct: f.top10Pct, organicBuyers: f.organicBuyers, snipers: f.snipers, copycat: !!m.copycat, creatorPriorGraduations: m.creatorHistory ? m.creatorHistory.priorGraduations : 0, flags };
  }

  _checkpoint(m, now) {
    const cps = this.cfg.checkpointsS;
    if (m.decision || m.pending || m.checking || m.nextCheckpoint >= cps.length) return;
    const ageS = (now - m.createdAt) / 1000;
    if (ageS < cps[m.nextCheckpoint]) return;
    const checkpointS = cps[m.nextCheckpoint];
    const f = this.tracker.features(m, now);
    const d = evaluate(f, { copycat: m.copycat, creator: m.creatorHistory, socials: m.socials, lastCheckpoint: m.nextCheckpoint === cps.length - 1 }, this.cfg);
    if (d.action === 'wait') { m.nextCheckpoint++; return; }
    if (d.action === 'reject') return this._record(m, f, 'reject', d.reasons, d.flags, checkpointS, 0);
    const gate = this.risk.canEnter();
    if (!gate.ok) return this._record(m, f, 'blocked', d.reasons.concat('risk: ' + gate.reason), d.flags, checkpointS, d.sizeSol);
    this.risk.reserve();
    if (!this.cfg.entry.checkMint || !this.checkMint) return this._buy(m, d, f, checkpointS);
    m.checking = true;
    this.checkMint(m.mint).then((r) => r, (e) => ({ ok: false, reason: 'mint check error: ' + e.message })).then((r) => {
      m.checking = false;
      if (!r.ok) { this.risk.release(); return this._record(m, f, 'reject', d.reasons.concat('mint check: ' + r.reason), d.flags, checkpointS, 0); }
      this._buy(m, d, f, checkpointS);
    });
  }

  _buy(m, d, f, checkpointS) {
    this._record(m, f, 'buy', d.reasons, d.flags, checkpointS, d.sizeSol);
    this.broker.open(m, d, f);
  }

  _horizons(m, now) {
    const o = m.outcome;
    if (!o || o.done) return;
    for (const h of this.cfg.outcomes.horizonsS) {
      if (o.marks[h] || now - o.decidedAt < h * 1000) continue;
      o.marks[h] = o.ref ? { maxMult: o.max / o.ref, minMult: o.min / o.ref, lastMult: o.last / o.ref, graduated: !!o.graduatedAt } : null;
    }
    const lastH = Math.max(...this.cfg.outcomes.horizonsS);
    if (now - o.decidedAt >= lastH * 1000) {
      o.done = true;
      this.store.append('outcomes', { mint: m.mint, symbol: m.symbol, ...o, graduated: !!o.graduatedAt, graduatedAfterS: o.graduatedAt ? (o.graduatedAt - o.decidedAt) / 1000 : null });
    }
  }

  tick() {
    const now = this.now();
    for (const m of [...this.tracker.mints.values()]) {
      this._checkpoint(m, now);
      if (m.position && !m.position.closing) this._checkExit(m, now);
      this._horizons(m, now);
      if (m.outcome && m.outcome.done && !m.position && !m.pending && !m.checking) this.tracker.delete(m.mint);
    }
    if (now - this.lastHousekeeping > 60000) {
      this.lastHousekeeping = now;
      this.store.saveCreators();
      this.store.pruneNames(this.cfg.filters.copycatWindowH);
    }
  }

  status(feedState) {
    const positions = [...this.broker.positions.values()].map((p) => {
      const m = this.tracker.mints.get(p.mint);
      const f = m ? this.tracker.features(m) : null;
      return { mint: p.mint, symbol: p.symbol, sizeSol: p.sizeSol, openedAt: p.openedAt, holdS: (this.now() - p.openedAt) / 1000, entryPrice: p.entryPrice, price: f && f.price, changePct: f && f.price ? (f.price / p.entryPrice - 1) * 100 : null, takeProfitDone: p.takeProfitDone, closing: p.closing, solRaised: f && f.solRaised };
    });
    return {
      mode: 'paper', startedAt: this.startedAt, now: this.now(),
      feed: feedState || null,
      tracker: { ...this.tracker.stats, tracking: this.tracker.mints.size },
      risk: this.risk.status(),
      totals: { ...this.totals, winRatePct: this.totals.trades ? (this.totals.wins / this.totals.trades) * 100 : null },
      positions,
      recentDecisions: this.recentDecisions.slice(0, 50),
      recentTrades: this.broker.recent.slice(0, 30),
      config: { checkpointsS: this.cfg.checkpointsS, entry: this.cfg.entry, filters: this.cfg.filters, exit: this.cfg.exit, risk: this.cfg.risk },
    };
  }
}

module.exports = { Sniper };
