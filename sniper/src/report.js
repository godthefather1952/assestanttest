#!/usr/bin/env node
'use strict';
// Summarises the paper results and compares what happened after each kind of decision, so the filters can be refit.
//   node src/report.js [--days 7] [--dir data] [--json]
const fs = require('node:fs');
const path = require('node:path');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function load(dir, days, now = Date.now()) {
  const out = { trades: [], outcomes: [], candidates: [] };
  if (!fs.existsSync(dir)) return out;
  const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 10);
  for (const d of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= cutoff).sort()) {
    for (const k of Object.keys(out)) out[k].push(...readJsonl(path.join(dir, d, k + '.jsonl')));
  }
  return out;
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Groups reject reasons into the filter that fired.
const CATEGORIES = [
  ['copycat', /copycat/], ['dev sold first', /dev already sold/], ['launch-block cluster', /launch-block cluster/],
  ['top-10 concentration', /top 10 wallets/], ['crowded (snipers)', /crowded/], ['past entry cap', /entry cap/],
  ['too slow', /too slow/], ['mint check', /mint check/], ['risk limit', /^risk:/], ['not a SOL curve', /not SOL/],
  ['no CreateEvent', /without CreateEvent/], ['costs too high', /priority fees are/], ['curve complete', /already complete/],
];
function category(o) {
  if (o.action === 'buy') return 'BOUGHT';
  if (o.action === 'blocked') return 'would buy, blocked by risk limit';
  for (const [name, re] of CATEGORIES) if (re.test(o.reason || '')) return 'rejected: ' + name;
  return 'rejected: other';
}

function summarize(data) {
  const trades = data.trades.filter((t) => t.kind === 'trade');
  const failed = data.trades.filter((t) => t.kind === 'entry_failed');
  const pnl = trades.map((t) => t.pnlSol), pnlPct = trades.map((t) => t.pnlPct);
  const byExit = {};
  for (const t of trades) { const k = t.exitReason.replace(/[\d.]+ SOL/, 'N SOL'); (byExit[k] = byExit[k] || []).push(t.pnlPct); }
  const failReasons = {};
  for (const f of failed) { const k = f.reason.replace(/[\d.]+%/g, 'N%'); failReasons[k] = (failReasons[k] || 0) + 1; }
  const groups = {};
  for (const o of data.outcomes) (groups[category(o)] = groups[category(o)] || []).push(o);
  const outcome = Object.entries(groups).map(([name, os]) => {
    const at = (h, k) => os.map((o) => o.marks && o.marks[h] && o.marks[h][k]).filter((x) => typeof x === 'number');
    const max180 = at(180, 'maxMult'), min180 = at(180, 'minMult');
    return {
      group: name, n: os.length,
      medianMax180: median(max180),
      hit2x180Pct: max180.length ? (max180.filter((x) => x >= 2).length / max180.length) * 100 : null,
      fellHalf180Pct: min180.length ? (min180.filter((x) => x <= 0.5).length / min180.length) * 100 : null,
      medianLast600: median(at(600, 'lastMult')),
      graduatedPct: (os.filter((o) => o.graduated).length / os.length) * 100,
    };
  }).sort((a, b) => b.n - a.n);
  return {
    trades: { n: trades.length, wins: trades.filter((t) => t.pnlSol > 0).length, winRatePct: trades.length ? (trades.filter((t) => t.pnlSol > 0).length / trades.length) * 100 : null, pnlSol: pnl.reduce((a, b) => a + b, 0), meanPnlPct: mean(pnlPct), medianPnlPct: median(pnlPct), costsSol: trades.reduce((a, t) => a + t.costsSol, 0) + failed.reduce((a, t) => a + t.costsSol, 0), meanHoldS: mean(trades.map((t) => t.holdS)) },
    entryFailures: { n: failed.length, reasons: failReasons },
    exits: Object.entries(byExit).map(([reason, xs]) => ({ reason, n: xs.length, meanPnlPct: mean(xs) })).sort((a, b) => b.n - a.n),
    outcomes: outcome,
    decisions: data.candidates.length,
  };
}

function fmt(n, d = 1, suffix = '') { return n == null ? '–' : n.toFixed(d) + suffix; }

function print(s) {
  const t = s.trades;
  console.log(`Paper trades: ${t.n} · wins ${t.wins} (${fmt(t.winRatePct, 0, '%')}) · P&L ${fmt(t.pnlSol, 4)} SOL · mean ${fmt(t.meanPnlPct, 1, '%')} · median ${fmt(t.medianPnlPct, 1, '%')} · costs ${fmt(t.costsSol, 4)} SOL · mean hold ${fmt(t.meanHoldS, 0, 's')}`);
  console.log(`Failed entries: ${s.entryFailures.n}` + (s.entryFailures.n ? ' — ' + Object.entries(s.entryFailures.reasons).map(([k, v]) => `${k}: ${v}`).join('; ') : ''));
  if (s.exits.length) { console.log('\nExits:'); for (const e of s.exits) console.log(`  ${e.reason.padEnd(48)} ${String(e.n).padStart(5)}  mean ${fmt(e.meanPnlPct, 1, '%')}`); }
  console.log('\nWhat happened after each decision (price vs the decision price; 180 s and 600 s after):');
  console.log('  ' + 'group'.padEnd(42) + 'n'.padStart(7) + '  med max180  hit 2x  fell 50%  med last600  graduated');
  for (const o of s.outcomes) console.log('  ' + o.group.padEnd(42) + String(o.n).padStart(7) + fmt(o.medianMax180, 2, 'x').padStart(11) + fmt(o.hit2x180Pct, 1, '%').padStart(8) + fmt(o.fellHalf180Pct, 1, '%').padStart(10) + fmt(o.medianLast600, 2, 'x').padStart(13) + fmt(o.graduatedPct, 1, '%').padStart(11));
  console.log(`\n${s.decisions} decisions logged. Compare BOUGHT with each rejected group: a filter is earning its place when its group does worse than BOUGHT.`);
}

if (require.main === module) {
  const a = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
  const dir = path.resolve(a('--dir', path.join(__dirname, '..', 'data')));
  const s = summarize(load(dir, Number(a('--days', 7))));
  if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 2)); else print(s);
}

module.exports = { load, summarize, category, median };
