# XAUTUSD Delta Next.js Live Bot

This project implements the EMA100 reclaim/rejection breakout strategy for XAUTUSD.

## Strategy
- Setup candle timeframe comes from `RESOLUTION` (for example `1m`, `5m`, `15m`, `1h`)
- EMA 100
- EMA trend = EMA now vs EMA `SLOPE_LOOKBACK` bars ago
- BUY setup: open below EMA and close above, OR open/close above EMA with low below EMA
- SELL setup: reverse
- Entry: live price breaks the setup candle high/low
- SL: setup candle low/high
- TP: configured RR (default 8R)
- One position at a time
- Risk = configured percentage of Delta available margin
- Minimum stop %, max effective leverage, max fee/risk %, max daily consecutive losses
- Market entry, then Delta exchange-side market bracket SL + TP

## Polling architecture
`POLL_MS=1000` is used for the fast live ticker/breakout check only.

Other REST data is intentionally throttled:
- Ticker / breakout price: every `POLL_MS` (default 1 second)
- Position: every 5 seconds, plus an immediate re-check before entry
- Wallet / available margin: every 30 seconds, plus an immediate refresh before risk sizing
- 180 historical candles: only when a new candle for the configured `RESOLUTION` has completed

This keeps breakout detection fast without requesting candles, wallet, and position every second.

## Risk and leverage
The live bot uses Delta `available_balance_for_robo` (fallback: `available_balance`) as its trading/risk base.

Example: with $148 available and `RISK_PCT=1`, planned price-risk is about $1.48.

The effective-leverage safety check also uses available margin:

`effectiveLeverage = position notional / available margin`

The trade is rejected when estimated entry + estimated exit fees + GST exceed `MAX_FEE_RISK_PCT` of planned risk.

## Setup
```bash
cp .env.example .env.local
# Put your own Delta demo API key/secret in .env.local
npm install
npm run dev
```

Open http://localhost:3000 and click Start Bot.

## Secure dashboard setup

The web dashboard and its APIs require an administrator session. The standalone trading worker remains independent and continues monitoring when users log out or sessions expire.

Add these values to `.env.local` (never commit that file):

```bash
MONGODB_URI=mongodb://your-private-connection-string
MONGODB_DB=trading_dashboard
AUTH_SECRET=a-random-secret-with-at-least-32-characters
```

Generate `AUTH_SECRET` with a cryptographically secure password generator. Create the initial administrator once by passing temporary environment values directly to the command:

```bash
read -r "INITIAL_ADMIN_EMAIL?Admin email: "
read -rs "INITIAL_ADMIN_PASSWORD?Admin password: "
export INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD
npm run create-admin
unset INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD
```

The password prompt is hidden. The password must be at least 14 characters. The command stores only a bcrypt hash and refuses to overwrite an existing account. Do not add either `INITIAL_ADMIN_*` value to `.env.local`; in production, inject them using your platform's one-time secret facility. Rotate the Delta API credentials that were previously present in `.env.example`, because removing a secret from the current file does not remove it from Git history.

Sessions expire after eight hours. Login throttling uses atomic MongoDB counters with a 15-minute TTL, so it applies across multiple web instances. Account throttling is always active. Source-IP and source-plus-account throttling are enabled only when `TRUST_PROXY_IP_HEADERS=true`. Set that option only behind a trusted hosting proxy that overwrites (rather than accepts or appends arbitrary client input to) `X-Forwarded-For`/`X-Real-IP`; leave it false when that guarantee is unavailable.

The default test suite never connects to a production database. To run the opt-in authentication integration suite, provide `AUTH_TEST_MONGODB_URI` for a dedicated disposable MongoDB test deployment. The suite creates and drops a uniquely named database:

```bash
AUTH_TEST_MONGODB_URI='mongodb://dedicated-test-server' npm test
```

## Delta environments
- Production REST: `https://api.india.delta.exchange`
- Demo/Testnet REST: `https://cdn-ind.testnet.deltaex.org`

Demo and live API keys are different. Trading API keys may require the server public IP to be whitelisted.

## XAUTUSD price source
For this strategy, use `PRICE_SOURCE=last` when you want breakout detection to match Delta's **Traded Price** chart. The dashboard also shows mark, last traded, and spot prices separately.

## Signal-candle entry / stop rule

This live bot mirrors the backtester rule exactly:

- BUY: trigger = signal candle HIGH; stop loss = signal candle LOW.
- SELL: trigger = signal candle LOW; stop loss = signal candle HIGH.
- The breakout candle does not replace or move this initial stop loss.
- Breakout monitoring remains fast using `POLL_MS` (recommended `1000` ms), while setup detection uses completed candles at the configured `RESOLUTION`.



## Dynamic resolution
No candle duration is hard-coded. `RESOLUTION` controls all candle-time calculations used by the worker and candle-history lookback.

Examples:
- `RESOLUTION=1m` -> 60-second candles
- `RESOLUTION=5m` -> 300-second candles
- `RESOLUTION=15m` -> 900-second candles
- `RESOLUTION=1h` -> 3600-second candles

`EMA_LENGTH` and `SLOPE_LOOKBACK` are counts of bars, so they automatically follow the selected resolution. For example, `EMA_LENGTH=100` with `RESOLUTION=1m` is EMA100 of 1-minute candles; with `RESOLUTION=5m` it is EMA100 of 5-minute candles.


## Traded Price / EMA alignment fix

- Historical setup candles use the plain Delta symbol (for example `XAUTUSD`), which Delta documents as **Traded Price** OHLC. `MARK:XAUTUSD` is not used for strategy candles.
- `PRICE_SOURCE=last` makes breakout detection use Delta's **last traded price**, matching the chart when the **Traded Price** tab is selected.
- EMA warm-up is no longer based on a fixed 180 candles. The worker derives a longer history from `EMA_LENGTH` and `SLOPE_LOOKBACK` (capped at Delta's 2000-candle REST limit). For EMA100 this requests 1013 bars, greatly reducing EMA seed mismatch versus a long-history chart/backtest.
- `RESOLUTION` continues to control candle duration dynamically; there is no hard-coded 5-minute timing.

## Manual SL/TP synchronisation + clearer statuses
- While a bot-tracked position is open, the worker fetches Delta active orders every 5 seconds.
- If SL/TP is manually edited or removed on Delta, `activeTrade` is updated from the exchange and a permanent synchronisation event is recorded.
- Entry events are permanent in the decision log: later `WAIT / EXISTING_POSITION` polling does not overwrite a candle row that already recorded an entry. Bot-created open trades are titled `ENTRY · ALGO POSITION OPEN`, while a position discovered on Delta before app startup is titled `ACTIVE · EXISTING POSITION`.
- The dashboard separates the current bot state from permanent trade/synchronisation events (`ORDER_SENT`, `BRACKET_SENT`, SL/TP sync/removal, position close).

## Existing Delta position on app startup

If XAUTUSD already has a non-zero Delta position before the worker starts, the worker adopts it as `activeTrade` with source `exchange_existing`. The dashboard shows `ACTIVE · EXISTING POSITION`, current size and entry price, and synchronizes the live exchange SL/TP every 5 seconds. While that position remains open, the normal one-position-at-a-time guard prevents any new algo entry. Closing the adopted position does not alter the bot's daily loss streak because the trade was not created by the bot.

## Persistent trade history

Completed XAUTUSD trades are stored server-side in MongoDB's `trades` collection and exposed only through authenticated `GET /api/trades` and `GET /api/trades/stats` routes. History supports `page`, `limit` (maximum 100), `source=bot|exchange_existing`, and a validated symbol filter. Statistics are aggregated in MongoDB as separate bot, manual, and account scopes.

The collection creates these indexes: unique `tradeId`; compound `source + exitTime`; compound `symbol + exitTime`; `exitTime`; and `createdAt`. Bot identity uses the entry exchange order ID so its OPEN and CLOSED states update the same record. Exchange-existing identity requires attributable fill IDs. Writes use atomic upserts; timestamps are never used as the sole identity.

Actual entry/exit prices use quantity-weighted Delta fills when attributable. For an adopted exchange-existing position, Delta's live position average is retained as the actual entry source and the exit still requires fills. `brokerage` is the sum of Delta fill `commission` values for attributed entry and exit fills. Delta's fill schema does not expose attributable GST, so actual `GST`, `totalCharges`, and actual `netPnL` remain null unless all actual charge components are known. The configured taker rate and `GST_PCT` populate only `estimatedBrokerage`, `estimatedGST`, `estimatedTotalCharges`, and `estimatedNetPnL`; the dashboard never labels them “paid.”

MongoDB and reconciliation failures are recorded as worker trade-history events and do not reject signals, change sizing, or modify exchange execution. Ownership resolution has four reporting states: bot confirmed, manual confirmed, unknown, and lookup failed. A timeout/error is never evidence of manual ownership. An OPEN bot record is restored only when its `ema-` client order, entry fills, product, side, and uninterrupted Delta fill lifecycle connect it to the current position; direction or size alone is insufficient. Uncertain positions remain monitored and continue blocking a second XAUTUSD entry, but they enter neither bot nor manual performance and never affect the bot loss streak.

On a zero-position startup/reconnect reporting pass, OPEN/RECONCILING bot records are checked against bounded, cursor-paginated Delta fills and order history (up to ten 50-record pages). A provable close updates the same trade record; otherwise it remains RECONCILING with a safe diagnostic. This closes the normal restart window after an asynchronous close write, without blocking order protection or changing trading behavior.

Fill attribution is conservative. Bot exits require the exact owned quantity, confirmed entry fills, and exit-order evidence; a manual addition, oversized/cross-boundary fill, missing order, incomplete pagination, or mixed lifecycle makes actual financial attribution unavailable. Manual exits require an exact position-close transition within the last live observation window, without additions/reversals. Unknown values stay null. Reporting quantity is capped at the ownership snapshot, and a 7-contract fill is never charged as an actual 5-contract bot exit.

Statistics return known sums together with coverage counts and completeness booleans for gross P/L, brokerage, GST, total charges, and net P/L. “Paid” and complete Net P/L labels require every trade in that scope to be reconciled; otherwise the dashboard shows known values and `reported / total` coverage. Win rate is consistently based on actual gross P/L, not a mixture of gross and net outcomes. Bot, manual, and account known sums remain additive; unknown ownership is excluded from those scopes.

The worker does not import a manual trade that opened and closed entirely while it was offline. No claim of complete historical manual import is made. Actual and estimated brokerage/GST/charges/net P/L remain separate in storage and in the history table.

`MAX_DAILY_CONSECUTIVE_LOSSES` counts only reliably established realized losses from confirmed bot-owned positions. Delta TP fills reset the streak and Delta SL fills increment it regardless of where the ticker moves afterward. An exactly attributable profitable manual close resets the consecutive-loss streak; an exactly attributable losing manual close increments it but remains labelled `MANUAL_CLOSE`, not SL. Breakeven or unprovable exits leave the streak unchanged. This control classification uses read-only Delta fills/orders and never depends on MongoDB trade-history persistence.

MongoDB integration tests are opt-in and must use a disposable deployment; they create and drop a random database:

```sh
TRADE_TEST_MONGODB_URI='mongodb://dedicated-test-server' npm test
```


## Stop Robot behavior

`STOP ROBOT` is now a hard master switch for new algo entries. The worker keeps Delta monitoring alive so an already-open XAUTUSD position, live size, synchronized SL/TP and position closure still update on the dashboard. Stopping clears any pending setup and prevents new signal creation. The worker re-checks the control state immediately before exchange-side entry actions and again immediately before the MARKET order, preventing an in-progress polling cycle from submitting a new trade after STOP was clicked. If a MARKET order was already sent before STOP, the bot still places the protective bracket so the open position is not left unprotected. While stopped with an open position the UI shows `STOPPED · POSITION STILL OPEN`; while stopped flat it shows `STOPPED · NO NEW TRADES`. Pressing START resumes new-signal processing from a new completed candle.
# 100-EMA-Strategy-Live-Trading-Strategy
