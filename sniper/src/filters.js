'use strict';
// Entry decision for one checkpoint. Pure: features + context + config in, decision out.
//   action 'buy'    paper-buy now, at size sizeSol
//   action 'wait'   not yet (velocity too low); look again at the next checkpoint
//   action 'reject' stop considering this token
// Every rule maps to a row of the research parameter sheet; `reasons` say which rules fired, so outcome logs can show
// what each rule filtered out.

function evaluate(f, ctx, cfg) {
  const F = cfg.filters, E = cfg.entry;
  const reasons = [], flags = [];
  let mult = 1;
  const reject = (r) => ({ action: 'reject', sizeSol: 0, reasons: reasons.concat(r), flags });

  // Integrity and market type.
  if (F.requireSolQuote && !f.solLike) return reject('curve quoted in ' + f.quoteMint + ', not SOL');
  if (!f.hasCreateEvent) return reject('launch seen without CreateEvent: name unknown, copycat check impossible');
  if (f.completed) return reject('curve already complete');

  // Rules with outcome evidence.
  if (ctx.copycat) return reject('copycat of an earlier coin (name and symbol)');
  if (f.devSold && F.skipIfDevSold) return reject('dev already sold');

  // Tool-consensus thresholds.
  if (f.block0Pct >= F.block0RejectPct) return reject(`launch-block cluster holds ${f.block0Pct.toFixed(1)}% (limit ${F.block0RejectPct}%)`);
  if (f.top10Pct > F.top10RejectPct) return reject(`top 10 wallets hold ${f.top10Pct.toFixed(1)}% (limit ${F.top10RejectPct}%)`);
  if (f.snipers > F.maxSnipers) return reject(`crowded: ${f.snipers} snipers (limit ${F.maxSnipers})`);
  if (f.solRaised > E.maxSolRaised) return reject(`curve holds ${f.solRaised.toFixed(2)} SOL, past the ${E.maxSolRaised} SOL entry cap`);

  // Size adjustments.
  if (f.block0Pct >= F.block0HalfPct) { mult *= 0.5; flags.push(`launch-block cluster ${f.block0Pct.toFixed(1)}%: half size`); }
  const c = ctx.creator || {};
  if (c.launches7d >= F.creatorMaxLaunches7d) { mult *= 0.5; flags.push(`creator launched ${c.launches7d} coins in 7 days: half size`); }
  if (c.priorGraduations > 0 && c.quietDays >= F.creatorQuietDays) { mult *= F.creatorBoost; flags.push(`creator graduated a coin before and was quiet ${c.quietDays.toFixed(0)} days: size x${F.creatorBoost}`); }
  if (ctx.socials) {
    if (ctx.socials.telegram) flags.push('telegram link');
    if (ctx.socials.twitter) flags.push('twitter link');
    if (ctx.socials.website) flags.push('website link');
  }
  if (!f.mintSuffixPump) flags.push('mint lacks pump suffix');

  // Velocity (placeholders until refit): wait for the next checkpoint, reject after the last one.
  const slow = [];
  if (f.solRaised < E.minSolRaised) slow.push(`${f.solRaised.toFixed(2)} SOL raised (min ${E.minSolRaised})`);
  if (f.organicBuyers < E.minOrganicBuyers) slow.push(`${f.organicBuyers} organic buyers (min ${E.minOrganicBuyers})`);
  if (slow.length) {
    if (ctx.lastCheckpoint) return reject('too slow: ' + slow.join(', '));
    return { action: 'wait', sizeSol: 0, reasons: reasons.concat('waiting: ' + slow.join(', ')), flags };
  }

  const sizeSol = Math.min(E.maxSizeSol, Math.round(E.sizeSol * mult * 1e4) / 1e4);
  const costPct = ((E.tipSol + E.priorityFeeSol) * 2 / sizeSol) * 100;
  if (costPct > E.maxCostPct) return reject(`tips and priority fees are ${costPct.toFixed(1)}% of a ${sizeSol} SOL position (limit ${E.maxCostPct}%)`);
  return { action: 'buy', sizeSol, reasons, flags };
}

module.exports = { evaluate };
