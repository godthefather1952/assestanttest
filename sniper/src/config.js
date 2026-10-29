'use strict';
// Defaults come from reports/Solana sniper parameter sheet (research of 29 Oct 2026). Values marked "placeholder" have no
// outcome evidence behind them; refit them from this bot's own outcome logs (npm run report) before trusting them.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  mode: 'paper', // the only mode: this bot has no wallet and never signs or sends a transaction
  rpc: {
    wsUrl: null, // from RPC_WS_URL
    httpUrl: null, // from RPC_HTTP_URL
    commitment: 'processed',
    staleMs: 15000, // reconnect when no message arrives for this long (pump.fun trades constantly)
  },
  dataDir: path.join(__dirname, '..', 'data'),
  seed: null, // RNG seed for simulated landing failures; null = time-based
  // Decisions are made at these ages after the launch (report: compute velocity at t+5/15/60 s).
  checkpointsS: [5, 15, 60],
  entry: {
    sizeSol: 0.25, // report: 0.1-0.5 SOL
    maxSizeSol: 0.5,
    maxSolRaised: 15, // report: enter only while <=10-15 SOL is in the curve (<=1.78-2.25x launch price)
    minSolRaised: 1, // placeholder
    minOrganicBuyers: 5, // placeholder: unique buyers outside the launch block and the dev
    latencyMs: 800, // detection to landed fill for a non-co-located VPS on a websocket feed (report: 150-300 ms feed + ~220 ms submit + 1-2 slots)
    buySlippagePct: 12, // report: 8-12% for early entry
    failRate: 0.1, // simulated landing failures (report: vendor figures 6-32%)
    tipSol: 0.001, // per leg; report: keep tips + priority fees <=5% of position
    priorityFeeSol: 0.00002,
    maxCostPct: 5,
    checkMint: true, // read the mint over RPC before each paper buy: authorities null, Token-2022 extensions allowlisted
    fetchMetadata: false, // fetch the token's metadata URI for socials (soft signal only); off to save time and requests
  },
  filters: {
    requireSolQuote: true, // pump curves can now be quoted in other tokens; only SOL curves are priced here
    block0HalfPct: 5, // report: dev + linked launch-block supply <5% pass, 5-10% half size, >=10% reject
    block0RejectPct: 10,
    top10RejectPct: 30, // report: backstop, tool consensus 25-30%
    maxSnipers: 20, // report: crowding signal; GMGN danger >20
    sniperSlots: 2, // buyers within this many slots of the launch count as snipers
    copycatWindowH: 24, // report: reject copies of an earlier coin's name and symbol
    creatorMaxLaunches7d: 5, // report soft negative: >=5 launches in 7 days halves size
    creatorBoost: 1.5, // report: prior graduate and >=7 days quiet is a size boost, never a gate
    creatorQuietDays: 7,
    skipIfDevSold: true,
  },
  exit: {
    timeStopS: 120, // report: flip exits inside 60-180 s
    stopPct: -30, // report: -25% to -35% backstop only
    takeProfitPct: 100, // sell takeProfitFraction at 2x
    takeProfitFraction: 0.7,
    trailPct: 25, // trail the remainder from its peak
    onDevSell: true, // report: exit immediately when the dev or linked wallets sell
    onLinkedSell: true,
    completeAtSol: 80, // sell before the curve completes (~85 SOL) and trading moves to PumpSwap
    latencyMs: 800,
    slippagePct: 10,
    completeHaircutPct: 10, // a sell that lands after completion is priced at the final curve price less this
    maxSellAttempts: 3,
  },
  risk: {
    maxOpen: 3,
    dailyLossSol: 1,
    maxEntriesPerHour: 20,
    maxConsecutiveLosses: 8,
    lossPauseMin: 30,
  },
  outcomes: {
    horizonsS: [60, 180, 600], // prices tracked after each decision, for refitting the filters
    maxSamples: 4000,
  },
  server: {
    host: '127.0.0.1',
    port: 8787,
    token: null, // from DASHBOARD_TOKEN; required when host is not loopback
  },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function validate(cfg) {
  const errors = [];
  const num = (v, name, min, max) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errors.push(`${name} must be ${min}-${max}`); };
  if (cfg.mode !== 'paper') errors.push('mode must be "paper": this bot has no wallet');
  num(cfg.entry.sizeSol, 'entry.sizeSol', 0.001, 100);
  num(cfg.entry.maxSizeSol, 'entry.maxSizeSol', cfg.entry.sizeSol, 100);
  num(cfg.entry.maxSolRaised, 'entry.maxSolRaised', 0, 85);
  num(cfg.entry.latencyMs, 'entry.latencyMs', 0, 60000);
  num(cfg.entry.failRate, 'entry.failRate', 0, 1);
  num(cfg.entry.maxCostPct, 'entry.maxCostPct', 0, 100);
  num(cfg.exit.stopPct, 'exit.stopPct', -100, 0);
  num(cfg.exit.takeProfitFraction, 'exit.takeProfitFraction', 0, 1);
  num(cfg.exit.timeStopS, 'exit.timeStopS', 1, 86400);
  num(cfg.risk.maxOpen, 'risk.maxOpen', 1, 100);
  if (!Array.isArray(cfg.checkpointsS) || !cfg.checkpointsS.length || cfg.checkpointsS.some((s) => !(s > 0))) errors.push('checkpointsS must be positive seconds');
  if (!Array.isArray(cfg.outcomes.horizonsS) || !cfg.outcomes.horizonsS.length) errors.push('outcomes.horizonsS must be a list');
  return errors;
}

// Reads config.json (if present) over the defaults, then the environment. Keys and URLs with keys come only from the
// environment so they never end up in a file in the repository.
function load(file, env = process.env) {
  let fileCfg = {};
  if (file && fs.existsSync(file)) fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = merge(DEFAULTS, fileCfg);
  if (env.RPC_WS_URL) cfg.rpc.wsUrl = env.RPC_WS_URL;
  if (env.RPC_HTTP_URL) cfg.rpc.httpUrl = env.RPC_HTTP_URL;
  if (env.DASHBOARD_TOKEN) cfg.server.token = env.DASHBOARD_TOKEN;
  if (env.SNIPER_DATA_DIR) cfg.dataDir = env.SNIPER_DATA_DIR;
  const errors = validate(cfg);
  if (errors.length) throw new Error('Invalid config: ' + errors.join('; '));
  return cfg;
}

// For logs and the dashboard: hides query strings and path segments that may hold an API key.
function redactUrl(url) {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol + '//' + u.host + (u.pathname.length > 1 ? '/…' : '') + (u.search ? '?…' : ''); } catch (e) { return '(invalid URL)'; }
}

module.exports = { DEFAULTS, load, merge, validate, redactUrl };
