# NIGHTSHIFT v1

A mobile-first Solana opportunity desk that runs as a static webpage. NIGHTSHIFT discovers live markets, performs checks it can actually verify, calculates deterministic Momentum and Opportunity scores, and presents the best setups in a minimalist Mission Control interface.

## v1 scope

- Single mobile webpage; no build step
- Apple-like Mission Control Lite dark UI
- Live DexScreener market data
- Basic Pump/PumpSwap identification from DexScreener markets
- Public Solana RPC safety verification where available
- Mint authority and freeze authority checks
- Raw top-10 token-account concentration (informational; pools/vaults are not fully classified in v1)
- Dynamic liquidity guardrail
- Momentum score from 5m buy/sell pressure, volume pace, transaction activity, price acceleration and locally observed liquidity change
- Opportunity score combining Safety, Momentum and Liquidity quality
- SNIPE / MOMENTUM / RUNNER / PASS classification
- Review screen with Approve / Reject
- Approval starts local tracking only; **no wallet transaction is sent**
- $10 default tracking size, $35 maximum
- Maximum 3 tracked positions
- $35 daily tracked-loss halt for new approvals
- Local browser history and evaluation records
- JSON history export

## Data sources

NIGHTSHIFT is keyless-first:

1. **DexScreener public API** supplies live Solana pair data such as price, liquidity, volume, recent transactions, pair age and token metadata.
2. **Public Solana JSON-RPC** is used to verify mint/freeze authority and read largest token accounts.

Pump.fun discovery in this version is deliberately conservative. The app identifies Pump/PumpSwap markets present in the public DexScreener feed and uses a Pump search fallback. It does **not** claim to be a complete firehose of every newly created Pump.fun token. A direct real-time PumpPortal stream currently requires an API key even though new-token subscriptions themselves are free, so that dependency is intentionally excluded from the keyless MVP.

## Safety model

NIGHTSHIFT never invents a pass for data it cannot verify. In v1:

**Hard/verified checks**
- Minimum liquidity
- Mint authority
- Freeze authority

**Visible but limited**
- Raw top-10 token-account concentration. This may include pool/vault accounts, so it is treated cautiously rather than represented as definitive insider ownership.

**Marked unverified in v1**
- Deployer history
- Insider/bundle clustering
- Transfer restrictions / honeypot behavior beyond what can be established by the current sources

If Solana RPC verification fails, the Opportunity score is capped and the setup cannot become **Ready** for approval.

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

Hard safety failures cap the score. Unverified on-chain safety also caps the score below the Ready threshold.

## Local state

Browser storage is used for positions, desk decisions, evaluated-token snapshots and outcome tracking. Use **History → Export** to download the locally stored NIGHTSHIFT dataset as JSON.

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
| Automated exits | Disabled |
| Social scraping | Disabled |
| Deep historical whale intelligence | Disabled |

## Important v1 limitation

This is an opportunity-analysis and local tracking interface, not an autonomous trading system. It does not connect to a wallet, place orders, or guarantee that a token is safe. Scores are deterministic heuristics based on the data available to the browser and should be treated as measurements to inspect, not facts about future performance.
