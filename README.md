# NIGHTSHIFT v1

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

**Verified Safety** reports the existing heuristic only when core on-chain checks are available; otherwise it displays **Unknown**. **Verification Coverage** is separate: 8 categories comprise liquidity, token program, mint authority, freeze authority, holder data, deployer history, insider clustering and transfer restrictions. Coverage is 1/8 (13%, rounded) before core RPC verification and at most 5/8 (63%) afterwards. The last three remain explicitly unknown. A Verified Safety value of 100 means no penalty among observed checks, not complete verification or a probability of safety. Opportunity retains its prior weighting; coverage is not an additional score multiplier.

## Simulated EXIT engine

The EXIT engine manages **tracked positions only**. It does not connect to a wallet or submit a sell transaction.

Default v1 exit rules:

- Hard protective stop: **-12%**
- After the position reaches **+15%**, the protective stop moves to approximately breakeven
- Target 1: at **+20%**, simulate closing **35%** of the original position
- Target 2: at **+40%**, simulate closing another **35%**
- Final **30%** becomes a runner with a **15% trailing stop from the observed peak**
- Liquidity exit if live liquidity falls below **$10,000**
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

The page contacts `api.dexscreener.com`, `api.mainnet-beta.solana.com`, and `api.mainnet.solana.com`. Those providers receive your IP address and requested token addresses; DexScreener also receives search terms. Token images are limited to `https://cdn.dexscreener.com`, whose operator can observe image requests. Requests omit credentials and referrers, reject API redirects, and time out after 9 seconds per endpoint. RPC fallback may take longer overall.

A Content Security Policy restricts scripts to same-origin `app.js`, connections to the listed APIs, and images to the listed CDN. Inline event handlers are removed. Solana addresses are validated as base58-encoded 32-byte values before requests and rendering; dynamic attributes are escaped. No wallet, private key, transaction-signing or transaction-submission functionality is present. Local state is not intentionally uploaded by this app; export creates a user-downloaded JSON file.

## Regression checks

Run `node --test tests/guardrails.test.cjs` (Node 18+). These tests use mocked RPC and market data and cover approval gates, verification coverage, holder integrity, stale quotes, independent monitoring, persistence, restore validation, injection inputs and review races.

An optional browser smoke test is available with Playwright and Chromium installed: `node tests/browser-smoke.cjs`. It uses mocked external responses and checks the mobile scan/review/approve/export/restore flow. Neither suite establishes live RPC reliability or real-world token safety.
