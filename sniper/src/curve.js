'use strict';
// pump bonding-curve math on virtual reserves, in integer units (lamports and token base units), mirroring
// @pump-fun/pump-sdk 4.3.1 (getBuyTokenAmountFromSolAmount / getSellSolAmountFromTokenAmount):
//   buy:  net = (budget - 1) * 10000 / (10000 + feeBps); tokens = net * vT / (vS + net), capped at real token reserves
//   sell: gross = tokens * vS / (vT + tokens); proceeds = gross - fee
// feeBps is the total charged to the trader (protocol + creator), read from the latest TradeEvent for the curve.
const LAMPORTS = 1_000_000_000n;
const TOKEN_DECIMALS = 6;

function big(v) { return typeof v === 'bigint' ? v : BigInt(v); }

function buyQuote(curve, budgetLamports, feeBps) {
  const budget = big(budgetLamports), vS = big(curve.vS), vT = big(curve.vT), fee = big(feeBps);
  if (budget <= 1n || vS <= 0n || vT <= 0n) return { tokens: 0n, net: 0n, fee: 0n };
  const net = ((budget - 1n) * 10000n) / (10000n + fee);
  let tokens = (net * vT) / (vS + net);
  if (curve.realT !== undefined && tokens > big(curve.realT)) tokens = big(curve.realT);
  return { tokens, net, fee: budget - net };
}

function sellQuote(curve, tokens, feeBps) {
  const t = big(tokens), vS = big(curve.vS), vT = big(curve.vT), fee = big(feeBps);
  if (t <= 0n || vS <= 0n || vT <= 0n) return { lamports: 0n, gross: 0n, fee: 0n };
  const gross = (t * vS) / (vT + t);
  const feeAmount = (gross * fee + 9999n) / 10000n; // ceil, as the program rounds fees up
  return { lamports: gross > feeAmount ? gross - feeAmount : 0n, gross, fee: feeAmount };
}

// Spot price in SOL per whole token (6 decimals).
function price(curve) {
  const vS = Number(big(curve.vS)), vT = Number(big(curve.vT));
  if (!(vS > 0 && vT > 0)) return null;
  return (vS / 1e9) / (vT / 10 ** TOKEN_DECIMALS);
}

function sol(lamports) { return Number(big(lamports)) / 1e9; }
function lamports(solAmount) { return BigInt(Math.round(solAmount * 1e9)); }

module.exports = { buyQuote, sellQuote, price, sol, lamports, LAMPORTS, TOKEN_DECIMALS };
