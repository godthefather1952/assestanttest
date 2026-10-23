# Scanner verification — October 23, 2026

Baseline: main/PR 2 merge `21d42799aeb7ab225e7d929be3712de683bc7ebb`.
Deployed origin: https://godthefather1952.github.io/assestanttest/.
The deployed app.js and scanner-data.js were downloaded and matched the baseline files byte for byte. This review adds tests and documentation; scanner runtime behavior is unchanged.

## Result

The browser integration and conservative failure behavior now have executed Chromium and WebKit evidence. Live holder-data availability still fails. Use the scanner for supervised, simulated observation; these results do not establish token safety, an executable sell route or dependable exit monitoring during missing market data.

| Check | Observed result | Evidence limit |
| --- | --- | --- |
| Node regression suite | 26/26 pass | Mocked inputs and DOM harness |
| Chromium 153 smoke | Pass: Scanner v2.1, scan, review, approve exactly one stored position, export/restore, no page errors or horizontal overflow | Mocked market/RPC; mobile viewport |
| WebKit 26.5 smoke | Same flow passes with iPhone 13 device emulation | Linux WebKit, not actual iPhone Safari |
| Browser failure suite | 9/9 checks pass in each engine | Mocked providers; includes two liquidity subtests |
| Real deployed page in cloud Chrome | Version visible; live discovery and review work; missing holders keep approval disabled | No live qualified-token approval was attempted |
| Real deployed-origin RPC in WebKit | Mint lookup succeeds; holder lookup fails on every provider | Discovery isolated with mocked empty responses; RPC and deployed scripts are real |
| CORS/CSP during live WebKit probe | All returned RPC HTTP responses expose Access-Control-Allow-Origin: *; no CSP violations recorded | Applies to these requests and this browser/environment only |
| Cooldown | Immediate retry causes no HTTP request; after real 61 seconds, all three providers are retried | Retry eligibility succeeds; providers do not recover |
| Pacing | Browser mocked-provider test observes request starts at least 325ms apart, allowing 25ms observer tolerance around the configured 350ms | Live responses take seconds, so the live run cannot isolate the minimum pacing interval |

Actual iPhone Safari remains untested: no iPhone or macOS Safari runtime is available. Device emulation cannot certify iOS downloads, file-picker behavior, storage restrictions, background timer suspension or app resume behavior.

## Failure scenarios executed

- Unknown liquidity: AWAITING DATA, explicit UNKNOWN and disabled approval. Zero liquidity: REJECTED and a confirmed floor failure. Neither case initiates unnecessary RPC verification.
- Holder-only outage: authority checks remain DISABLED, holder concentration remains UNKNOWN, coverage is 50%, all provider reasons remain visible and approval is disabled.
- Total provider outage: safety Unknown, 13% coverage, actionable errors and disabled approval.
- Delayed verification followed by switching reviews: the second token stays displayed after the first token's response arrives; its approval state updates from its own evidence.
- Duplicate approval: reopening the tracked token's review disables approval with Already tracking.
- Tracked token loses liquidity evidence, even while its observed price drops: position remains present and becomes STALE; no WIN/LOSS exit is fabricated. A later confirmed zero triggers a single liquidity exit.
- Browser RPC fallback: all provider attempts occur in order, starts are paced, cooldown suppresses immediate network traffic, an injected 61-second time advance permits retry and a later successful result is cached.
- Coverage/trust boundary: the deliberately incomplete mocked market has a supported dexId but no pairAddress, vault or reserve evidence; successful mint/holder responses still permit Ready at 63% coverage. This documents the current limitation, not an assurance about such a market.

Unknown liquidity currently returns before *all* simulated exit rules, including the protective price stop. STALE therefore means monitoring cannot be relied upon to generate protective exits until usable market evidence returns.

## Live results

The scripted WebKit probe ran from 05:28:22–05:30:14 UTC on October 23 (01:28–01:30 America/New_York). It queried the wrapped-SOL mint solely to exercise RPC methods, not to approve or recommend it. It used the repository's createRpc client and the same fetch timeout/credentials/referrer/redirect settings as app.js, in the actual deployed document origin.

| Provider | Initial mint lookup | Initial holder lookup | Holder retry after real cooldown |
| --- | --- | --- | --- |
| PublicNode | HTTP 200, value present | HTTP 429 | 9-second timeout |
| OnFinality | Not needed after mint success | HTTP 429 | HTTP 429 |
| Solana public mainnet | Not needed after mint success | HTTP 403 | HTTP 403 |

The immediate holder repeat returned cooldown reasons in approximately 1ms with no extra HTTP request. A real 61-second delay followed the completed first round; the next round retried all three providers and again failed. The raw record is [live-webkit-probe-2026-10-23.json](live-webkit-probe-2026-10-23.json).

Separately, the unmodified cloud Chrome page displayed PublicNode mint success, holder errors of 403/429/403, AWAITING DATA, 50% coverage and a disabled Not Ready button. Provider status varies by environment and time. A 100/100 observed-check safety score can still appear with missing holder data; the coverage and approval gate must be read alongside it.

Local Chromium could not perform the scripted live-origin probe: direct navigation returned ERR_EMPTY_RESPONSE, and the environment proxy returned ERR_CERT_AUTHORITY_INVALID. Certificate validation was not bypassed. The live scripted evidence comes from WebKit, whose normal trust path successfully reached the origin.

## What market evidence still means

1. **Pool/vault attribution is absent.** poolSupported only allowlists dexId strings. verify reads the token mint and largest token accounts; it does not decode a pool account, verify a DEX program owner, resolve vault authorities or establish which accounts are liquidity infrastructure. The raw >90% concentration block remains conservative but cannot distinguish vault concentration from insider ownership.
2. **Bonding curves are unsupported.** pumpfun is not an approved market adapter. Reserve decoding, virtual versus real reserves and migration state are not implemented. PumpSwap identification does not validate a Pump.fun curve.
3. **Sellability is unverified.** There is no amount-specific sell quote, minimum output, slippage/fee/price-impact check or transaction simulation. DexScreener price/liquidity observations are not executable sell prices. No sell or wallet transaction was submitted in this verification.
4. **63% is category coverage, not a safety probability.** Deployer history, insider clustering and transfer restrictions remain unknown. Passing these browser tests does not fill those evidence gaps.

Before using Ready as a trading decision, implement and verify pool/vault attribution and amount-specific sell-route evidence; keep bonding curves unsupported until a reserve adapter is validated. Restore dependable holder-data access as a separate prerequisite. Actual iPhone Safari still needs the same happy/failure flows plus background/resume and backup-file checks.

## Reproduction

See README's Browser failure checks and live probes section. Smoke and failure tests use mocked providers and make no wallet transactions. The live probe waits a real 61 seconds and records provider failures rather than treating availability as an assertion that must pass. No tests were skipped in the successful Chromium/WebKit runs.
