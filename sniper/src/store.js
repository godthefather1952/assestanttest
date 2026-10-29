'use strict';
// Files under dataDir:
//   YYYY-MM-DD/candidates.jsonl  every final decision (buy or reject) with its features and reasons
//   YYYY-MM-DD/trades.jsonl      every paper trade and failed entry
//   YYYY-MM-DD/outcomes.jsonl    price path after each decision (for refitting filters)
//   creators.json                launches (8 days) and graduations (30 days) per creator wallet
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400000;

function jsonSafe(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Set ? [...x] : x));
}

class Store {
  constructor(dataDir, { now = Date.now } = {}) {
    this.dir = dataDir;
    this.now = now;
    fs.mkdirSync(dataDir, { recursive: true });
    this.creatorsFile = path.join(dataDir, 'creators.json');
    this.creators = this._loadCreators();
    this.names = new Map(); // copycat index: name|symbol -> first seen time (in memory, rolling window)
    this.dirty = false;
  }

  append(kind, record) {
    const t = this.now();
    const day = new Date(t).toISOString().slice(0, 10);
    const dir = path.join(this.dir, day);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, kind + '.jsonl'), jsonSafe({ t, ...record }) + '\n');
  }

  _loadCreators() {
    try { return JSON.parse(fs.readFileSync(this.creatorsFile, 'utf8')); } catch (e) { return {}; }
  }

  saveCreators() {
    if (!this.dirty) return;
    // Launches are only used for the 7-day count and the 7-day quiet rule, so 8 days are kept (about 26,000 launches a
    // day would otherwise make this file grow by megabytes a week). Graduations are kept 30 days.
    const launchCutoff = this.now() - 8 * DAY, gradCutoff = this.now() - 30 * DAY;
    for (const [k, c] of Object.entries(this.creators)) {
      c.launches = c.launches.filter((t) => t >= launchCutoff);
      c.graduations = c.graduations.filter((t) => t >= gradCutoff);
      if (!c.launches.length && !c.graduations.length) delete this.creators[k];
    }
    const tmp = this.creatorsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.creators));
    fs.renameSync(tmp, this.creatorsFile);
    this.dirty = false;
  }

  // History before this launch: launches in the previous 7 days, graduations in the kept window, days since the previous launch.
  creatorHistory(creator, before) {
    const c = this.creators[creator];
    if (!c) return { launches7d: 0, priorGraduations: 0, quietDays: Infinity, known: false };
    const prior = c.launches.filter((t) => t < before);
    const last = prior.length ? Math.max(...prior) : null;
    return {
      launches7d: prior.filter((t) => t >= before - 7 * DAY).length,
      priorGraduations: c.graduations.filter((t) => t < before).length,
      quietDays: last === null ? Infinity : (before - last) / DAY,
      known: true,
    };
  }

  recordLaunch(creator, at) {
    if (!creator) return;
    const c = this.creators[creator] || (this.creators[creator] = { launches: [], graduations: [] });
    c.launches.push(at);
    this.dirty = true;
  }

  recordGraduation(creator, at) {
    if (!creator) return;
    const c = this.creators[creator] || (this.creators[creator] = { launches: [], graduations: [] });
    c.graduations.push(at);
    this.dirty = true;
  }

  // True when the same name and symbol were seen on another coin within the window. The first coin is not a copy.
  isCopycat(key, at, windowH) {
    if (!key) return false;
    const first = this.names.get(key);
    if (first !== undefined && at - first <= windowH * 3600000 && first < at) return true;
    if (first === undefined || at - first > windowH * 3600000) this.names.set(key, at);
    return false;
  }

  pruneNames(windowH) {
    const cutoff = this.now() - windowH * 3600000;
    for (const [k, t] of this.names) if (t < cutoff) this.names.delete(k);
  }
}

module.exports = { Store, jsonSafe };
