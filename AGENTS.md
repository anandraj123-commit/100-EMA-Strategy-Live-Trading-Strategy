# TRADING STRATEGY CONTRACT

The trading strategy and `tests/strategy-regression/` are protected behavior.
The user's explicitly confirmed strategy is authoritative over historical code,
comments, README descriptions, and old test expectations.

Do NOT modify any of the following unless the user EXPLICITLY requests a strategy change:

- BUY A: open < EMA, close > EMA, UP trend.
- BUY B: open > EMA, close > EMA, low <= EMA, UP trend.
- SELL A: open > EMA, close < EMA, DOWN trend.
- SELL B: open < EMA, close < EMA, high >= EMA, DOWN trend.
- EMA semantics: configurable length (including 75 and 100), SMA seed and recursive EMA.
- Slope semantics: compare EMA[current] with EMA[current - slopeLookback]; equality is neither trend.
- Completed signal candle semantics and the configurable timeframe (default 5m).
- Trigger rules: LONG signal high; SHORT signal low.
- Signal SL rules: LONG signal low; SHORT signal high, immutable while pending.
- Breakout timing: signal T0 cannot enter; exactly the following N candles are eligible; T(N+1) is expired.
- Breakout strictness: LONG price > trigger; SHORT price < trigger; equality never enters.
- entryValidCandles semantics, single-pending retention and expiry.
- RR semantics: trigger +/- abs(trigger - signalSL) * RR, with exchange tick normalization.
- Available-margin risk sizing, contract value and quantity flooring semantics.
- Minimum-stop semantics, leverage guards, ORDER_LEVERAGE, fee/GST guards and daily-loss semantics.
- Strategy regression expected results.

If another task appears to require changing any protected behavior, STOP and report
the conflict. Do NOT make tests pass by changing expected strategy behavior.
Do not bypass strategy tests, remove their discovery, or substitute source-string
checks for executable behavioral coverage.

## Candle identity convention

T0/T1/T2 refer to the latest **completed** candle's opening timestamp in the
worker. T0 processing creates pending and cannot enter, even on another poll
with that same candle identity. Eligibility is `[T0 + resolution, T0 + (N+1) * resolution)`
in completed-candle timestamp space. This is not the current live candle's
opening timestamp. For a 10:00 signal on 5m bars, T0 is processed after 10:05,
T1 after 10:10, T2 after 10:15, and T3 after 10:20. Publication grace can delay
observation; the final barrier also uses clock-derived completed-candle time
to prevent stale history extending expiry. No arbitrary delay defines eligibility.

Run the dedicated contract suite and the repository validation after relevant changes:

```sh
node --import tsx --test tests/strategy-regression/*.test.ts
npm run validate
```

## ONE OPEN POSITION RULE

Only one open position is allowed per portfolio. While positionSize != 0:
- no new executable pending setup
- no additional entry order, including same-direction or opposite-direction entry
- signals are informational only and are not replayed later
- pending that created the position is consumed and cannot execute twice

After the position is confirmed fully flat, wait for a new completed signal;
do not execute signals formed while the position was open or already completed
at flat confirmation. Fresh position checks and existing entry leases remain required.
Decision Logs must communicate POSITION OPEN — NEW ENTRY BLOCKED while open.
This rule and its regression tests must not be modified unless the user explicitly
requests a strategy change.
