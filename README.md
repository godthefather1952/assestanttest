# NIGHTSHIFT — Scanner v2.4

## v2.4: Token-2022 extension review

Token-2022 mints are no longer blocked wholesale. The mint's parsed extension list is reviewed and shown as its own evidence row. A token passes only if every extension is benign (`metadataPointer`, `tokenMetadata`, group/group-member pointers and tokens, `mintCloseAuthority`) or present but inert (an unset permanent delegate or transfer hook, a zero and locked transfer fee, an initialized default account state with no freeze authority).

Blocked, as a hard failure that caps the score and prevents approval: a permanent delegate (can move or burn any holder's tokens), a transfer hook (or a hook authority that could set one), any non-zero transfer fee or a fee authority that could set one later, frozen-by-default accounts, non-transferable, pausable, confidential transfer/mint-burn, scaled or interest-bearing display amounts, and **any extension the app does not recognise**. If the RPC returns no parsed extension list the token stays UNKNOWN and cannot be approved.

Limits: this reads the mint only. It does not examine swap-level behaviour, so the sell quote and the rest of the evidence still apply, and deployer history and insider clustering remain NOT CHECKED. In a live sample on 23 Oct 2026, 20 of 21 recent Token-2022 mints carried only metadata extensions and passed; one carried a transfer fee and was blocked.


## v2.3: enter provider keys on the site

Tap the ⚙ button, paste a free Helius key (or the full Helius RPC URL) and optionally a Jupiter key, then **Save and reload**. **Test keys** checks them first without saving. No command line, deploy or backend is needed.

- Keys are stored only in this browser under `nightshift_keys_v1`: not in the repo, not in state backups or exports, never shown again (only "ending ####"), entered in password fields, and redacted from error text. They go only to `mainnet.helius-rpc.com` (query parameter, as Helius requires) and `api.jup.ag` (`x-api-key` header).
- With a Helius key, Helius is tried first and the public endpoints remain as fallback. Without keys nothing changes.
- Risk: anyone who can use the unlocked browser can read the keys from developer tools, and a script injected into the page could too (the CSP limits this to same-origin scripts). Use free-plan keys only, never a key that can spend money, and rotate a key if a device is lost. Keys are per device.
- The Cloudflare Worker proxy in PR #5 is optional and not needed for this.


## v2.2: provider resilience, on-chain market evidence and sell quotes

Wallet execution stays disabled, approval remains manual and every guardrail value below is unchanged. Provider pricing and the backend decision are in [docs/provider-research-2026-10-23.md](docs/provider-research-2026-10-23.md); nothing has been purchased or deployed.

- **Providers.** RPC, DexScreener and the quote API each have pacing, in-flight de-duplication, caching and cooldowns that depend on the failure (429 backs off 60 s doubling to 15 min and honours `Retry-After`; 401/403 waits 10 min; a disabled method waits 30 min; timeouts and network errors 30–60 s). A recent RPC result may be shown only after every provider fails, with its original timestamp and a stale flag; evidence older than 10 minutes blocks approval. The data panel names provider, method, error and time to retry.
- **Price and liquidity are separate.** A fresh DexScreener price keeps the −12% stop, breakeven, targets, trailing stop, momentum and time exits armed even when liquidity is missing. Liquidity exits fire only on a known value (a reported zero still exits). A position becomes STALE only when its price is missing or older than two minutes, the market is no longer a supported pool or no longer the tracked pool. Exit signals are marked at the observed price; no fill or executable quote is ever assumed.
- **Pools are verified on-chain.** The pool address from the market feed is read from RPC: its owner must be a known DEX program for the reported DEX, its layout must name the market's base and quote mints, and both vaults must be token accounts holding those mints. Layouts for Raydium AMM v4/CPMM/CLMM, Orca Whirlpool, Meteora DLMM and PumpSwap were checked against live mainnet accounts on 23 Oct 2026; a wrong layout fails closed. Meteora DAMM v2/Dynamic AMM are recognised but unsupported. Ready now requires a verified pool.
- **Concentration.** Raw top-10 share counts every account; the infrastructure-adjusted share removes only the verified vaults of the one pool the feed reported (other pools or CEX wallets are not removed). Adjusted share gates when a pool is verified, otherwise raw gates. Shares are of total supply over the 20 largest accounts the RPC returns.
- **Sell quotes.** For $10/$20/$35 (and for a tracked position's remaining size) the app requests an exact-amount token→USDC quote (`GET /swap/v2/order` with no `taker`, so no transaction or wallet) and shows route availability, quote time and freshness (30 s), estimated and minimum output (at 1% slippage), API-reported price impact, fees, the computed shortfall versus the DexScreener mark and the route. Unreported fields read "not reported". A definitive no-route response blocks approval; an unreachable provider is shown as NOT VERIFIED and does not. A quote is an estimate, not a simulation or guarantee.
- **Bonding curves** remain unsupported: no reserve or migration adapter is validated, and a Pump.fun-owned account is never accepted as a pool.
- **Evidence instead of a score.** "Verified Safety 100/100" and coverage percentages are gone. Each check shows VERIFIED, REPORTED (third-party, not confirmed on-chain), FAILED, UNKNOWN, UNSUPPORTED or NOT CHECKED, with its source and time. Deployer history, insider clustering and transfer restrictions are NOT CHECKED. Opportunity still uses an internal score for ranking only.
- **Backend-ready, none required.** `config.js` can point `rpcEndpoints` and `quoteBase` at an approved server-side proxy; never put a key in that file (use the Settings screen). Add any new host to the CSP in `index.html`. Public RPCs still reject `getTokenLargestAccounts` (HTTP 429 in the 23 Oct live check), so without a keyed provider holders stay UNKNOWN and nothing becomes Ready.


## Browser-only data availability update (v2.1, superseded where noted above)

No backend, account signup, or API key is required. Automatic discovery now targets pool markets identified by DexScreener as Raydium, Orca, Meteora or PumpSwap. These identifiers select the market adapter; they are not proof of safety. Search can still show other markets, explicitly marked unsupported. Pump.fun bonding curves require a future reserve-based adapter and cannot become Ready in this version. Token-2022 approval depends on the extension review (v2.4).

Missing, null, blank, invalid or negative liquidity values display UNKNOWN rather than zero. A genuine reported zero still fails the floor. Unknown liquidity blocks approvals and simulated liquidity exits. Positions without usable market data become stale. The status distinguishes READY, REJECTED, AWAITING DATA, WATCHING and UNSUPPORTED.

RPC reads use PublicNode, OnFinality and Solana's public mainnet endpoint in that order. Requests are serialized and paced (350 ms between starts), duplicate in-flight requests share work, successful reads are cached for at most 60 seconds in memory (128 entries), and failed provider/method combinations enter a 60-second cooldown. Errors remain visible in the data-source panel. Failed requests are not cached as successful checks. When holder lookup fails after mint validation succeeds, the known mint checks stay visible but approval remains blocked. Verification coverage reflects those partial results.

The scanner publishes candidates before RPC completion and refreshes individual results progressively. It checks up to eight eligible candidates automatically per scan. Discovery still samples recent profiles/boosts (up to 40 addresses), with a SOL search fallback when no supported pools are found; it does not scan all Solana tokens. Token search remains available.

The page displays **Scanner v2.1** so users can identify an outdated deployment or tab. Public providers can still rate-limit, disable methods or reject browser requests. Pool/vault attribution, bonding-curve reserves and sell-quote validation are not implemented; raw concentration above 90% remains blocked. These changes improve data handling without relaxing safety rules or guaranteeing any token qualifies.

A mobile-first Solana opportunity desk that runs as a static webpage. NIGHTSHIFT discovers live markets, performs checks it can actually verify, calculates deterministic Momentum and Opportunity scores, and presents the best setups in a minimalist Mission Control interface.

## v1 scope

- Single mobile webpage; no build step
- Apple-like Mission Control Lite dark UI
- Live DexScreener market data
- Basic Pump/PumpSwap identification from DexScreener markets
- Public Solana RPC safety verification where available
- On-demand safety recheck whenever an unverified token is opened for review
- Mint-account type and supported token-program validation
- Mint authority and freeze authority checks using finalized RPC reads
- Raw top-10 token-account concentration; above 90% blocks approval (pool/vault attribution remains unavailable)
- Conservative Token-2022 handling: Token-2022 assets remain unverified until extension behavior is explicitly supported
- Dynamic liquidity guardrail
- Momentum score from 5m buy/sell pressure, volume pace, transaction activity, price acceleration and locally observed liquidity change
- Opportunity score combining Safety, Momentum and Liquidity quality
- SNIPE / MOMENTUM / RUNNER / PASS classification
- Review screen with Approve / Reject
- Approval starts local tracking only; **no wallet transaction is sent**
- $10 default tracking size, $35 maximum
- Maximum 3 tracked positions
- $35 daily tracked-loss halt for new approvals
- Simulated EXIT engine with stop, partial targets, breakeven protection, trailing logic, momentum/liquidity exits and setup-specific time exits
- Open positions refresh independently from the discovery feed
- Local browser history and evaluation records
- Complete versioned JSON export and validated backup restore

## Data sources

NIGHTSHIFT is keyless-first:

1. **DexScreener public API** supplies live Solana pair data such as price, liquidity, volume, recent transactions, pair age and token metadata.
2. **Public Solana JSON-RPC** is used to verify mint/freeze authority and read largest token accounts.

Pump.fun discovery in this version is deliberately conservative. The app identifies Pump/PumpSwap markets present in the public DexScreener feed and uses a Pump search fallback. It does **not** claim to be a complete firehose of every newly created Pump.fun token. A direct real-time PumpPortal stream currently requires an API key even though new-token subscriptions themselves are free, so that dependency is intentionally excluded from the keyless MVP.

## Safety model

NIGHTSHIFT never invents a pass for data it cannot verify. In v1:

**Hard/verified checks**
- Minimum liquidity
- Mint account exists and parses as a mint
- Mint is owned by the canonical SPL Token or Token-2022 program
- Mint authority field is explicitly present and disabled
- Freeze authority field is explicitly present and disabled
- Largest-holder RPC data is available and internally consistent

**Visible but limited**
- Raw top-10 token-account concentration. This may include pool/vault accounts, so it is not represented as definitive insider ownership. Raw concentration above 90% is nevertheless a hard approval block until attribution is supported. Holder amounts must be nonnegative integers, accounts unique, and the sum of all reported largest accounts no greater than supply.

**Marked unverified in v1**
- Deployer history
- Insider/bundle clustering
- Transfer restrictions / honeypot behavior beyond what can be established by the current sources

If Solana RPC verification fails, the Opportunity score is capped and the setup cannot become **Ready** for approval. Opening an unverified token's review screen triggers a fresh on-demand RPC validation attempt and shows the reason when verification still fails.

Token-2022 mints are treated conservatively. NIGHTSHIFT can read their basic mint/freeze authority fields, but because Token-2022 can include extensions such as permanent delegation, transfer hooks, fees, and default account state, v1 does not mark a Token-2022 asset **Ready** until those extension behaviors are explicitly supported.

## Scoring

Momentum uses recent market measurements, not an LLM. The score considers:

- 5m buy/sell pressure
- 5m volume relative to the current hourly pace
- 5m transaction activity
- 5m price acceleration, with an overheating penalty
- Liquidity change between local snapshots when available

Opportunity combines approximately:

- 48% Safety
- 42% Momentum
- 10% Liquidity quality

Hard safety failures cap Opportunity at 35. Unverified on-chain safety caps it at 74. Both the UI and approval function require Ready, Opportunity >=78, verified core checks, fresh candidate and position quotes, healthy storage, sufficient liquidity and available position capacity. Duplicate approvals are rejected.

**Evidence statuses** replace the former Verified Safety value and coverage percentage (see v2.2 above). Opportunity keeps its prior weighting using an internal penalty tally that is never shown as a safety score; it is capped at 74 until core checks and the pool are verified, and at 35 after any hard failure.

## Simulated EXIT engine

The EXIT engine manages **tracked positions only**. It does not connect to a wallet or submit a sell transaction.

Default v1 exit rules:

- Hard protective stop: **-12%**
- After the position reaches **+15%**, the protective stop moves to approximately breakeven
- Target 1: at **+20%**, simulate closing **35%** of the original position
- Target 2: at **+40%**, simulate closing another **35%**
- Final **30%** becomes a runner with a **15% trailing stop from the observed peak**
- Liquidity exit if known live liquidity falls below **$10,000** (unknown liquidity never triggers or disables other exits)
- Liquidity exit if live liquidity falls **20% or more from entry**
- Momentum-collapse exit when recent transaction activity is sufficient, buys fall below roughly **35%**, and 5-minute price change is **-7% or worse**
- Setup time limits for trades that fail to develop: about **20 minutes for SNIPE, 90 minutes for MOMENTUM, 4 hours for RUNNER, and 60 minutes for PASS**
- Time exits only fire when the position has not produced enough follow-through

Tracked positions are refreshed separately from the discovery queue so an approved token does not need to remain a current discovery candidate for the EXIT engine to keep checking it. Monitoring runs on its own non-overlapping 15-second schedule, independent of the 45-second discovery schedule and its RPC queue. Missing quotes mark positions **STALE** immediately; quotes older than 120 seconds also block new approvals and manual closes. Reloading, restoring and resuming the page require a fresh position lookup. Only the position monitor updates tracked prices and evaluates exits. Browser timers can pause in the background, so this does not provide unattended execution. Freshness measures successful API receipt, not independently verified exchange tick age.

Daily P&L across date boundaries uses the original token quantity, including partial exits. Day boundaries use the browser's local timezone and the last observed price as the new day's basis; these remain simulated accounting estimates.

## Local state

Browser storage is used for positions, desk decisions, evaluated-token snapshots and outcome tracking. History is limited to the newest 250 events. Evaluations, snapshots and dismissed-token maps each retain the newest 1,000 records plus any open-position records. Older records are pruned; this is not an unlimited archive.

**History → Export** downloads the complete persisted state in a `NIGHTSHIFT` version-2 envelope: positions, history, evaluations, snapshots, dismissed tokens, daily accounting and last refresh. Discovery candidates, the active filter, selected size and swipe session are transient. **History → Restore** validates a backup (maximum 5 MB), asks before replacement, saves it and refreshes position quotes. Legacy full local state is migrated automatically; the old incomplete history-only export cannot restore fields it never contained.

Storage write errors show a persistent warning and block new approvals until saving succeeds. Invalid saved data is preserved, never silently overwritten; Export includes the original raw recovery text when readable. Restore a valid backup to recover from a corrupt store. If a write fails, monitoring can continue in memory, but those changes are not durable until a later successful save.

Clearing site data will clear local NIGHTSHIFT history unless it has been exported.

## Run

No install or build process is required. Serve the repository as a static site or enable GitHub Pages from the repository root.

For local testing, any basic static file server works. Opening `index.html` directly can work, but an HTTP(S) origin is preferred because browsers apply stricter network rules to `file://` pages.

## Guardrails locked for this build

| Rule | Value |
|---|---:|
| Normal tracking size | $10 |
| Maximum tracking size | $35 |
| Maximum open positions | 3 |
| Daily tracked-loss halt | $35 |
| Base minimum liquidity | $10,000 |
| Wallet execution | Disabled |
| Simulated tracked-position exits | Enabled |
| Real automated wallet exits | Disabled |
| Social scraping | Disabled |
| Deep historical whale intelligence | Disabled |

## Important v1 limitation

This is an opportunity-analysis and simulated position-management interface, not an autonomous trading system. It does not connect to a wallet, place orders, or guarantee that a token is safe. Scores are deterministic heuristics based on the data available to the browser and should be treated as measurements to inspect, not facts about future performance.

## Network and data handling

The page contacts `api.dexscreener.com`, `mainnet.helius-rpc.com` (only if you save a Helius key), `api.jup.ag` (sell quotes; the token mint and amount are sent, no wallet), `solana-rpc.publicnode.com`, `solana.api.onfinality.io`, and `api.mainnet.solana.com`. Those providers receive your IP address and requested token addresses; DexScreener also receives search terms. Token images are limited to `https://cdn.dexscreener.com`, whose operator can observe image requests. Requests omit credentials and referrers, reject API redirects, and time out after 9 seconds per endpoint. RPC fallback may take longer overall.

A Content Security Policy restricts scripts to same-origin `app.js`, connections to the listed APIs, and images to the listed CDN. Inline event handlers are removed. Solana addresses are validated as base58-encoded 32-byte values before requests and rendering; dynamic attributes are escaped. No wallet, private key, transaction-signing or transaction-submission functionality is present. Local state is not intentionally uploaded by this app; export creates a user-downloaded JSON file.

## Regression checks

Run `node --test tests/guardrails.test.cjs tests/scanner-data.test.cjs tests/evidence.test.cjs` (Node 18+). These tests use mocked RPC and market data and cover approval gates, verification coverage, holder integrity, stale quotes, independent monitoring, persistence, restore validation, injection inputs, review races, unknown liquidity, market selection, provider fallback, request deduplication and cooldowns.

An optional browser smoke test is available with Playwright and Chromium installed: `node tests/browser-smoke.cjs`. It uses mocked external responses and checks the mobile scan/review/approve/export/restore flow. Neither suite establishes live RPC reliability or real-world token safety.

### Browser failure checks and live probes

Install Playwright (the October 23 verification used 1.62.1) and its browser dependencies. Run from the repository root:

```sh
npm install --no-save playwright@1.62.1
npx playwright install --with-deps chromium webkit
node tests/browser-smoke.cjs
node --test tests/browser-failures.cjs
BROWSER=webkit node tests/browser-smoke.cjs
BROWSER=webkit node --test tests/browser-failures.cjs
```

The failure suite covers unknown versus zero liquidity, holder-only and total provider outages, delayed verification while switching reviews, duplicate approval blocking, stale position handling without fabricated exits, browser request pacing, cooldown retry eligibility, price-only stops under unknown liquidity, on-chain pool evidence failures, sell-quote states and per-check evidence. Provider responses are mocked. The cooldown test advances the RPC client's injected time source by 61 seconds; request pacing uses real browser requests and timers. WebKit uses iPhone device emulation on Linux; it does not certify actual iPhone Safari, iOS file handling or background behavior.

`CHROMIUM_EXECUTABLE_PATH` optionally selects an existing Chromium binary in constrained test environments. It is not needed for a standard Playwright installation.

For a separate read-only live probe, run `node tests/browser-live-probe.cjs` or `BROWSER=webkit node tests/browser-live-probe.cjs`. This loads the deployed GitHub Pages origin, isolates RPC traffic by mocking only discovery, calls the real providers, checks immediate cooldown/cache behavior, waits a real 61 seconds and retries holder lookup. `SCANNER_URL` selects another deployed origin; `PROBE_OUTPUT` selects the JSON result path (default `/tmp/nightshift-live-probe.json`). `USE_ENV_PROXY=1` uses an environment-provided HTTPS proxy when required. The probe preserves browser certificate checks and records network failures, CORS headers and CSP violations. It does not send wallet transactions, establish sellability or assert that unavailable providers recovered.

See [the October 23 verification report](docs/scanner-verification-2026-10-23.md) for observed results and remaining limits.
