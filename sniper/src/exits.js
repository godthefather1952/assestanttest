'use strict';
// Exit decision for an open paper position. Pure: position + token features + config in, null or { reason, fraction } out.
// Order matters: wallet-based triggers first (report: exit immediately when the dev or linked wallets sell), then the
// curve nearing completion, then price rules, then the time stop.

function check(pos, f, now, cfg) {
  const X = cfg.exit;
  if (!pos || pos.closing || pos.remainingTokens <= 0n) return null;
  if (X.onDevSell && f.devSoldAt !== null && f.devSoldAt > pos.openedAt) return { reason: 'dev sold', fraction: 1 };
  if (X.onLinkedSell && f.linkedSoldAt !== null && f.linkedSoldAt > pos.openedAt) return { reason: 'launch-block wallet sold', fraction: 1 };
  if (f.completed) return { reason: 'curve completed', fraction: 1 };
  if (f.solRaised >= X.completeAtSol) return { reason: `curve reached ${f.solRaised.toFixed(1)} SOL, selling before completion`, fraction: 1 };
  if (f.price !== null) {
    if (f.price <= pos.entryPrice * (1 + X.stopPct / 100)) return { reason: `stop ${X.stopPct}%`, fraction: 1 };
    if (!pos.takeProfitDone && f.price >= pos.entryPrice * (1 + X.takeProfitPct / 100)) return { reason: `take profit +${X.takeProfitPct}%`, fraction: X.takeProfitFraction, takeProfit: true };
    if (pos.takeProfitDone && pos.peak && f.price <= pos.peak * (1 - X.trailPct / 100)) return { reason: `trailing stop ${X.trailPct}% from peak`, fraction: 1 };
  }
  if ((now - pos.openedAt) / 1000 >= X.timeStopS) return { reason: `time stop ${X.timeStopS}s`, fraction: 1 };
  return null;
}

module.exports = { check };
