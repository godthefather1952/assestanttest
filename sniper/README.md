# NIGHTSHIFT paper sniper

A server bot that watches every new pump.fun launch, decides within the first minute whether it would buy, and simulates the trade against the live bonding curve. **It has no wallet.** It never signs or sends a transaction, and `mode` cannot be set to anything but `paper`. Its job is to collect evidence: run it for 100–200 paper trades, then use `npm run report` to see whether the strategy and each filter earn their place before any real money is involved.

The strategy and every default come from the research sheet `Solana sniper parameter sheet` (29 Oct 2026): target the seconds after a launch rather than the launch block, which belongs to the creator's own bundles, enter only while 15 SOL or less is in the curve, and exit within minutes. This is design input, not financial advice.

## What it does

1. **Listens** to one websocket subscription (`logsSubscribe` on the pump program). Each pump transaction's logs carry its events, so no extra RPC call is made per trade.
2. **Tracks** every coin launched after the bot started: curve reserves, each wallet's balance from curve trades, wallets that bought in the launch slot, snipers, organic buyers, and whether the creator or launch-slot wallets have sold.
3. **Decides** at 5, 15 and 60 seconds after each launch: buy, wait or reject (rules below).
4. **Paper-buys** after a latency delay, priced on the curve as it stands then. A price jump beyond the slippage limit fails the entry, and a share of entries fail to land at random, as real ones do.
5. **Exits** on the first of: the creator or a launch-slot wallet selling, the curve nearing completion, a −30% stop, taking 70% off at 2x and trailing the rest, or 120 seconds.
6. **Records** every decision and, for 10 minutes after it, what the price did. That includes the coins it rejected, so you can see what each filter removed.

## Requirements

- Node.js 22 or newer (uses its built-in WebSocket and fetch; no npm dependencies).
- A Solana RPC with websocket `logsSubscribe` and HTTP `getAccountInfo`, for example Helius. Check your plan's websocket limits: the bot keeps one subscription open and reads one mint account per paper buy.
- A small Linux VPS. Frankfurt or Amsterdam is closest to most Solana block producers (about 52% of them in September 2026), but for paper mode any region works.

## Setup

```sh
git clone https://github.com/godthefather1952/assestanttest.git
cd assestanttest/sniper
cp config.example.json config.json        # optional: edit to change any setting
export RPC_WS_URL='wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
export RPC_HTTP_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
npm run check-feed                         # 30 s: confirms the feed decodes launches and trades
npm start
```

Keys are read only from the environment. `config.json` and `data/` are git-ignored; never commit a key.

`check-feed` prints how many of each event it decoded plus one sample of each. It must show `TradeEvent` and `CreateEvent`. The decoder was checked against Anchor's encoder using pump's official IDL (from `@pump-fun/pump-sdk` 4.3.1), but the build environment could not reach mainnet, so **run `check-feed` before trusting anything else**. If it decodes trades but no creates, the bot still tracks launches from the creator's first trade, but it rejects them all because the copycat check needs the coin's name.

### Run it as a service

`/etc/nightshift.env` (readable by root only, `chmod 600`):

```
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_HTTP_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

`/etc/systemd/system/nightshift-sniper.service`:

```
[Unit]
Description=NIGHTSHIFT paper sniper
After=network-online.target

[Service]
WorkingDirectory=/home/YOU/assestanttest/sniper
EnvironmentFile=/etc/nightshift.env
ExecStart=/usr/bin/node src/main.js
Restart=always
User=YOU

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now nightshift-sniper` and `journalctl -u nightshift-sniper -f` for the one-line status it prints every minute.

## Dashboard and kill switch

The dashboard listens on `127.0.0.1:8787`, so it is not reachable from the internet. Open it through an SSH tunnel:

```sh
ssh -L 8787:127.0.0.1:8787 you@your-vps
# then browse to http://localhost:8787
```

It shows feed health, whether entries are allowed and why not, paper P&L, open positions, recent trades and recent decisions with their reasons. **Kill switch** stops new entries; open positions still exit under their rules. You can also run `touch data/KILL` (delete the file to resume). To serve the dashboard on another address, set `server.host` and `DASHBOARD_TOKEN`; the bot refuses to start a non-local dashboard without a token.

## Decision rules

Checked at each checkpoint, in this order. Defaults are in `src/config.js`; "placeholder" means no outcome evidence supports the value yet.

| Rule | Default | Basis |
|---|---|---|
| Curve quoted in SOL | required | pump curves can now be quoted in other tokens; only SOL curves are priced |
| Copy of an earlier coin's name and symbol (24 h) | reject | originals graduate 9.20% vs copies 0.86% |
| Creator already sold | reject | creator's first sale comes within 1 minute on 64.8% of launches |
| Wallets that bought in the launch slot (creator included) hold | ≥10% reject, 5–10% half size | tool consensus; Bitquery found the first buys are the creator's bundle on 185 of 186 launches |
| Top 10 wallets hold | >30% reject | tool consensus backstop |
| Snipers (non-creator buyers within 2 slots) | >20 reject | crowding signal |
| SOL in the curve | >15 reject | report: enter at ≤1.78–2.25x the launch price |
| Creator launched ≥5 coins in 7 days | half size | soft negative |
| Creator graduated a coin before and was quiet ≥7 days | size ×1.5 | one vendor cohort; a boost, never a gate |
| SOL raised ≥1 and organic buyers ≥5 | wait, then reject at 60 s | placeholder |
| Tips + priority fees ≤5% of the position | else reject | at 0.1 SOL a 0.01 SOL tip each way costs 22.6% |
| Mint over RPC: mint and freeze authority null, Token-2022 extensions allowlisted | else reject | same rules as the scanner page (`../token2022.js`) |
| Risk: ≤3 open, ≤20 entries an hour, daily loss ≤1 SOL, pause 30 min after 8 losses in a row | else "blocked" | blocked decisions are still logged and tracked |

Paper fills: 0.25 SOL default size (0.5 max), 800 ms from decision to fill, 12% buy slippage, 10% simulated landing failures, 0.001 SOL tip plus 0.00002 SOL priority fee per leg, pump's fee as reported by the curve's latest trade. Sells are quoted on the live curve plus the paper buy's own effect on it.

## Results

```sh
npm run report               # last 7 days
npm run report -- --days 30 --json
```

The report gives paper P&L, win rate, costs, failed entries by reason, exits by reason, and a table of what happened after each kind of decision: median best price within 180 s, how many reached 2x, how many fell by half, and how many graduated. Read it as: a filter earns its place when the coins it rejected did worse than the coins bought. Refit the placeholder thresholds from these logs before trusting them.

Files in `data/`: `YYYY-MM-DD/candidates.jsonl` (every decision with its features), `trades.jsonl` (paper trades and failed entries), `outcomes.jsonl` (price after each decision), and `creators.json` (launches per creator for 8 days, graduations for 30).

## Known limits

- **Creator history starts empty.** The bot knows only the launches it has seen, so the creator rules do nothing for the first days.
- **The launch-slot cluster is approximate.** It counts every wallet that bought in the launch slot as linked to the creator, including independent snipers that landed there (28% of coins have one). It does not trace funding wallets.
- **Balances come from curve trades only.** Token transfers between wallets are not seen.
- **After the curve completes, coins trade on PumpSwap, which this bot does not price.** A sell that lands after completion is priced at the last curve price less 10%. The exit rules sell at 80 SOL to avoid this.
- **Migration (PumpSwap) entries are not implemented.** The research rates them a secondary mode; this version covers early entry on the curve only.
- **Socials are off by default.** `entry.fetchMetadata` fetches each coin's metadata for Telegram, X and website links (a soft signal, never a gate).
- **Paper is not live.** Real fills compete with other bots; the latency, slippage and failure settings are estimates.

## Tests

```sh
npm test
```

35 tests, all offline: the decoder against Anchor-encoded fixtures from the official IDL (including older, shorter event layouts), curve math against the SDK formulas, every filter, exit and risk rule, the websocket feed with a mock socket (including refused and hung connections), the dashboard's token check, and full launches replayed through the engine on a simulated curve with a fake clock.
