# NIGHTSHIFT proxy (Cloudflare Worker)

Status: **written and unit-tested, not deployed.** It exists so the Helius and Jupiter keys stay in Cloudflare secrets instead of the public page.

## What it does

| Route | Forwards to | Allowed |
| --- | --- | --- |
| `POST /rpc` | `https://mainnet.helius-rpc.com/?api-key=…` | One JSON-RPC call: `getAccountInfo`, `getMultipleAccounts` (max 5), `getTokenLargestAccounts`; validated addresses; only `commitment` (finalized/confirmed) and `encoding` (base64/jsonParsed) options; body ≤ 4 KB |
| `GET /order` | `https://api.jup.ag/swap/v2/order` with `x-api-key` | `inputMint` (valid address), `outputMint` = USDC only, `amount` (digits), optional `slippageBps` ≤ 1000. No `taker`, so no transaction can be built |

Anything else is refused before an upstream call. Successful reads are cached briefly (RPC 60–120 s, quotes 10 s) to save free-tier credits. Upstream errors become generic 502s; keys and upstream URLs are never returned. Requests must carry an `Origin` in `ALLOWED_ORIGINS` (default `https://godthefather1952.github.io`).

**Limit:** the origin check stops other websites from using your proxy from a browser. It cannot stop a script that fakes the `Origin` header, so anyone who learns the Worker URL could spend your free credits. Keep the URL out of public places you don't need, watch the Helius and Jupiter usage dashboards, and tell me if you want a shared-secret or Cloudflare rate-limiting rule added.

## Deploy (you run these; nothing here has been run)

1. Cloudflare dashboard → Workers & Pages → create a Worker (Free plan). Or from this repo: `npx wrangler login`, then `npx wrangler deploy`.
2. Add the secrets in the dashboard (Worker → Settings → Variables and Secrets → Secret) or with `npx wrangler secret put HELIUS_API_KEY` and `npx wrangler secret put JUPITER_API_KEY`. Do not paste keys into chat, issues or files.
3. Note the Worker URL (`https://nightshift-proxy.<your-subdomain>.workers.dev`).
4. In the app repo: set `config.js` to `{rpcEndpoints:['<worker-url>/rpc'],quoteBase:'<worker-url>'}` and add `<worker-url origin>` to `connect-src` in `index.html`. You can then remove `api.jup.ag` and the public RPC hosts from the CSP.
5. Check: open the deployed app; the data panel should show your Worker host, holders should load, and `Top 10 accounts` should leave UNKNOWN.

## Tests

`node --test tests/worker.test.mjs` (mocked upstreams; no network, no keys).
