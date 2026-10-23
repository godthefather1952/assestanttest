# Backend, RPC and token/swap API research — October 23, 2026

Nothing was purchased, signed up for or deployed. Figures come from the providers' own pages as returned by web search/fetch on this date; where sources disagree it is flagged. Re-check the pricing pages before committing — several vendors changed plans in 2026.

## Is a backend necessary?

**Not for the app to run, but yes for dependable holder data and for any API key.**

- PR #3's live probe showed all three public RPC endpoints rejecting `getTokenLargestAccounts` from a browser (429/429/403). Holder concentration therefore stays UNKNOWN and approval stays disabled in practice. A keyed RPC provider fixes that.
- Jupiter's `GET /swap/v2/order` (the only quote path found in current docs) lists an `x-api-key` header as required in its OpenAPI spec, although the portal also describes a keyless 0.5 RPS tier. A key shipped in a static page is public. A tiny proxy keeps it private.
- A proxy gives one shared cache and one rate-limit bucket instead of one per open tab.
- It is *not* needed for DexScreener (no key, CORS works) or for the wallet (execution stays disabled).

Smallest viable backend: a single Cloudflare Worker that allowlists three upstream calls (RPC read methods, Jupiter order, nothing else), checks `Origin`, adds the keys from Worker secrets and caches for a few seconds. No database, no wallet, no signing.

## Provider facts

| Provider | Free tier / entry price | Limits | Holder-query relevance | Notes |
| --- | --- | --- | --- | --- |
| [Helius](https://www.helius.dev/pricing.md) | Free $0: 1M credits/mo | 10 RPC rps, 5 getProgramAccounts rps, DAS 2 rps. Developer $49 (10M credits, 50 rps); Business $499 | Standard RPC calls cost 1 credit, so `getTokenLargestAccounts`, `getAccountInfo`, `getMultipleAccounts` are 1 each ([credits](https://www.helius.dev/docs/billing/credits)). DAS `getTokenAccounts` 10 credits for full holder lists | Exceeding limit returns 429. Docs disagree on some paid-tier RPS and an old $24.50 Developer price still circulates. Whether keys can be domain-restricted was not confirmed |
| [Alchemy](https://support.alchemy.com/articles/5827006872-what-is-included-in-the-free-tier) | Free: 30M CU/mo; then pay-as-you-go $0.45/M CU | 500 CU/s per one article, 300 CU/s per an older page | Standard Solana methods; per-method CU for `getTokenLargestAccounts` not confirmed | Billing moved from fixed plans to PAYG; moving off free bills from zero |
| [QuickNode](https://blog.quicknode.com/best-solana-rpc-providers-2026/) | No permanent free plan; trial credits; Build $49/mo (80M credits, 50 rps) | Solana methods ~30 credits each | Supported | Highest cost per call of those compared; third-party figures conflict |
| [Birdeye Data](https://docs.birdeye.so/docs/pricing) | Standard free: 30,000 CU, 1 rps, 3 endpoints; Starter $99 | 1 rps free | Holder endpoints not on the free tier as far as found | Not useful for light personal use |
| [Jupiter](https://developers.jup.ag/docs/portal/plans.md) | Free key: $0, 1 rps, unlimited credits; keyless 0.5 rps; Developer $25/mo (10 rps) | Shared bucket across Swap/Price/Token; 429 on excess | n/a. `/swap/v2/order` without `taker` returns a quote and no transaction; returns `outAmount`, `otherAmountThreshold`, `priceImpact`, `feeBps`, `platformFee`, `routePlan` ([reference](https://developers.jup.ag/docs/api-reference/swap/order.md)) | Older hub.jup.ag pages describe a different lite-api/60 rpm scheme; legacy-limit grace period ended 30 June 2026 |
| [DexScreener](https://docs.dexscreener.com) | Free, no key | Third-party wrappers report ~300 req/min for pair endpoints and 60/min for profile/boost lists; **not confirmed from official docs** | No holders; gives price, liquidity, volume, `pairAddress`, `dexId` | Already used; treated as untrusted market data |
| [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Free: 100,000 requests/day, 10 ms CPU per request | Paid plan $5/mo minimum, 20M requests/mo included then $0.60/M (a third-party calculator says 10M; official page used) | n/a | Proxying and caching fit within 10 ms CPU |

Reliability: none of the free tiers publishes an uptime commitment I could find, so reliability is rated from observed behavior (public endpoints failed in PR #3's probe) and from the vendors' reputation-neutral facts above, not from SLAs.

## Three practical combinations (light personal use)

Usage assumption: page open ~2 h/day. With the new client-side pacing and caching, roughly 1–3k RPC reads per open hour (about 60–180k/month) and well under 500 Jupiter quotes/month (one per review or size change).

| | A. Browser-only (today) | B. Free-tier proxy (**recommended**) | C. Paid comfort |
| --- | --- | --- | --- |
| Backend | none | Cloudflare Workers Free | Cloudflare Workers Paid |
| RPC | PublicNode / OnFinality / Solana public | Helius Free (1M credits, 10 rps) | Helius Developer (10M credits, 50 rps) |
| Market data | DexScreener | DexScreener | DexScreener |
| Quotes | Jupiter keyless 0.5 rps, may require key | Jupiter free key, 1 rps | Jupiter Developer, 10 rps |
| Holder queries | Failing in live probe | Supported (1 credit/call) | Supported |
| Credentials | none, nothing to hide | server-side Worker secrets | server-side Worker secrets |
| Reliability | Poor for holders/quotes | Good enough for supervised use; free-tier 429s possible | Best; far more headroom than needed |
| Est. monthly cost | $0 | **$0** (≈6–18% of Helius credits; Workers well under 100k/day) | ≈ $5 + $49 + $25 = **$79** |

If B outgrows the free tier the first thing to hit is Helius's 1M credits (not Workers): raise cache TTLs before paying. Alchemy's free 30M CU is a reasonable swap for Helius if its `getTokenLargestAccounts` cost is acceptable once checked in its CU table.

## Recommendation

**Option B**, built as a deliberately thin Worker, once you approve. Until then this PR ships the client side: provider/proxy-agnostic configuration (`NightshiftConfig.rpcEndpoints`, `quoteBase`) with no keys in the browser, so switching from public endpoints to a Worker URL is a configuration change plus a CSP `connect-src` entry. Option A remains usable for supervised price observation but cannot give dependable holder or quote evidence. Option C is not justified for personal use.

**Approvals needed before any spend or deploy:** creating Helius and Jupiter accounts (both free), creating a Cloudflare account/Worker, and the CSP/config change that points the page at the Worker.
