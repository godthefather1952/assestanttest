#!/usr/bin/env node
'use strict';
// NIGHTSHIFT paper sniper. Usage:
//   node src/main.js                 run (reads config.json if present, RPC_WS_URL / RPC_HTTP_URL from the environment)
//   node src/main.js --check-feed 30 connect for N seconds, print what the feed decodes, exit
const path = require('node:path');
const config = require('./config');
const { Store } = require('./store');
const { Feed } = require('./feed');
const { Sniper } = require('./engine');
const { checkMint, fetchSocials } = require('./rpc');
const { startServer } = require('./server');
const { jsonSafe } = require('./store');

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] || ''; }

async function checkFeed(cfg, seconds) {
  const feed = new Feed({ url: cfg.rpc.wsUrl, commitment: cfg.rpc.commitment, staleMs: cfg.rpc.staleMs });
  const counts = {}, samples = {};
  let txs = 0, createIx = 0;
  feed.on('tx', (tx) => {
    txs++;
    if (tx.hasCreateIx) createIx++;
    for (const ev of tx.events) {
      counts[ev.type] = (counts[ev.type] || 0) + 1;
      if (!samples[ev.type]) samples[ev.type] = { slot: tx.slot, signature: tx.signature, ...ev };
    }
  });
  console.log(`Connecting to ${config.redactUrl(cfg.rpc.wsUrl)} for ${seconds}s…`);
  feed.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  feed.stop();
  const s = feed.state;
  console.log(`Connected: ${s.connected}, subscribed: ${s.subscribed}, transactions: ${txs} (failed skipped: ${s.failedTx}), with a Create instruction: ${createIx}`);
  console.log('Decoded events:', JSON.stringify(counts));
  for (const [type, ev] of Object.entries(samples)) console.log(`\nSample ${type}:\n` + jsonSafe(ev).slice(0, 1500));
  if (s.lastError) console.log('Last error:', s.lastError);
  const ok = (counts.TradeEvent || 0) > 0;
  if (ok && !counts.CreateEvent && createIx) console.log('\nNo CreateEvent decoded although launches were seen: the bot will use its fallback (launches tracked, but the copycat check cannot run and every launch is rejected). Report this.');
  console.log(ok ? '\nFeed OK.' : '\nNo TradeEvent decoded. Check RPC_WS_URL and that your plan allows logsSubscribe.');
  process.exit(ok ? 0 : 1);
}

async function run(cfg) {
  const store = new Store(cfg.dataDir);
  const sniper = new Sniper({
    cfg, store,
    checkMint: (mint) => checkMint(cfg.rpc.httpUrl, mint, { commitment: cfg.rpc.commitment }),
    fetchSocials,
  });
  const feed = new Feed({ url: cfg.rpc.wsUrl, commitment: cfg.rpc.commitment, staleMs: cfg.rpc.staleMs });
  feed.on('tx', (tx) => sniper.onTx(tx));
  const feedState = () => ({ ...feed.state, healthy: feed.healthy(), url: config.redactUrl(cfg.rpc.wsUrl) });
  const ticker = setInterval(() => { sniper.setFeedHealthy(feed.healthy()); sniper.tick(); }, 250);
  const server = startServer(cfg.server, { getStatus: () => sniper.status(feedState()), kill: (r) => sniper.risk.kill(r), resume: () => sniper.risk.resume() });
  feed.start();
  console.log(`Paper sniper running. Feed: ${config.redactUrl(cfg.rpc.wsUrl)}. Dashboard: http://${cfg.server.host}:${cfg.server.port}/ . Data: ${cfg.dataDir}`);
  if (!cfg.rpc.httpUrl && cfg.entry.checkMint) console.log('Warning: RPC_HTTP_URL is not set, so every buy is rejected at the mint check.');
  const status = setInterval(() => {
    const s = sniper.status(feedState());
    console.log(`[${new Date().toISOString()}] feed ${s.feed.healthy ? 'live' : 'DOWN'} · launches ${s.tracker.creates} · tracking ${s.tracker.tracking} · decisions ${s.totals.decisions} (buy ${s.totals.buys}) · trades ${s.totals.trades} · P&L ${s.totals.pnlSol.toFixed(4)} SOL · ${s.risk.entriesAllowed ? 'entries allowed' : 'entries blocked: ' + s.risk.blockedBy}`);
  }, 60000);
  const shutdown = () => {
    clearInterval(ticker); clearInterval(status);
    feed.stop(); server.close();
    for (const p of sniper.broker.positions.values()) store.append('trades', { kind: 'abandoned', id: p.id, mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, sizeSol: p.sizeSol, note: 'bot stopped with this paper position open; excluded from results' });
    store.saveCreators();
    console.log('Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  let cfg;
  try { cfg = config.load(path.join(__dirname, '..', 'config.json')); } catch (e) { console.error(e.message); process.exit(1); }
  if (!cfg.rpc.wsUrl) { console.error('Set RPC_WS_URL (for example wss://mainnet.helius-rpc.com/?api-key=...) and RPC_HTTP_URL.'); process.exit(1); }
  const check = arg('--check-feed');
  if (check !== null) checkFeed(cfg, Number(check) || 30);
  else run(cfg);
}

module.exports = { run, checkFeed };
