// @ts-nocheck
// Reference JavaScript retained verbatim except lifecycle bridge hooks. No live imports.
export function mountReference(document, bridge, fetch = globalThis.fetch) {

// ============================================================
// DATE DEFAULTS: last 5 years
// ============================================================
const todayStr = new Date().toISOString().slice(0,10);
const fiveYearsAgo = new Date();
fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
document.getElementById('endDate').value = todayStr;
document.getElementById('startDate').value = fiveYearsAgo.toISOString().slice(0,10);

let cancelRequested = false;

// ============================================================
// DATA FETCH: Delta Exchange history/candles, paginated
// Resolution is fully dynamic — no timeframe is hard-coded.
// ============================================================
function resolutionToSeconds(resolution) {
  const value = String(resolution || '').trim().toLowerCase();
  const match = value.match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) {
    throw new Error(`Unsupported resolution "${resolution}". Use values such as 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60
  };

  return amount * multipliers[unit];
}

async function fetchCandles(symbol, resolution, startUnix, endUnix, onProgress) {
  const candleSeconds = resolutionToSeconds(resolution);
  const chunkSeconds = 2000 * candleSeconds; // Delta cap: 2,000 candles/request
  const bases = ['https://api.india.delta.exchange', 'https://api.delta.exchange'];
  let candles = [];
  let cursor = startUnix;
  const totalRange = Math.max(1, endUnix - startUnix);

  while (cursor < endUnix) {
    if (cancelRequested) throw new Error('Cancelled by user.');
    const chunkEnd = Math.min(cursor + chunkSeconds, endUnix);
    let success = false;
    let lastErr = null;

    for (const base of bases) {
      for (let attempt = 0; attempt < 2 && !success; attempt++) {
        try {
          const url = `${base}/v2/history/candles?resolution=${resolution}&symbol=${symbol}&start=${cursor}&end=${chunkEnd}`;
          const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data && Array.isArray(data.result)) {
            candles.push(...data.result);
            success = true;
          } else {
            throw new Error('Unexpected response shape');
          }
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 300));
        }
      }
      if (success) break;
    }

    if (!success) {
      throw new Error(
        `Failed to fetch candles for range ${new Date(cursor*1000).toISOString()} → ${new Date(chunkEnd*1000).toISOString()}. ` +
        `Last error: ${lastErr ? lastErr.message : 'unknown'}. This is usually a CORS or rate-limit block from the browser.`
      );
    }

    const pct = Math.min(100, ((chunkEnd - startUnix) / totalRange) * 100);
    onProgress(pct, candles.length);
    cursor = chunkEnd;
    await new Promise(r => setTimeout(r, 180)); // be polite to the API
  }

  candles.sort((a, b) => a.time - b.time);
  const seen = new Set();
  const deduped = [];
  for (const c of candles) {
    if (!seen.has(c.time)) { seen.add(c.time); deduped.push(c); }
  }
  return deduped;
}

// ============================================================
// EMA
// ============================================================
function computeEMA(closes, length) {
  const k = 2 / (length + 1);
  const ema = new Array(closes.length).fill(null);
  if (closes.length < length) return ema;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += closes[i];
  ema[length - 1] = sum / length;
  for (let i = length; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ============================================================
// STRATEGY SIMULATION (aligned to the live bot rules used by this project)
// ============================================================
function buildOneMinuteIndex(oneMinuteCandles, strategyResolutionSeconds) {
  const parentSec = strategyResolutionSeconds || 300;
  const oneMinuteByParent = new Map();

  for (const m of oneMinuteCandles) {
    const parentTime = Math.floor(m.time / parentSec) * parentSec;
    let arr = oneMinuteByParent.get(parentTime);
    if (!arr) {
      arr = [];
      oneMinuteByParent.set(parentTime, arr);
    }
    arr.push(m);
  }

  for (const arr of oneMinuteByParent.values()) arr.sort((a, b) => a.time - b.time);
  return oneMinuteByParent;
}

function getCompleteExecutionMinutes(oneMinuteByParent, strategyCandleTime, strategyResolutionSeconds) {
  const parentSec = strategyResolutionSeconds || 300;
  const expectedCount = parentSec / 60;
  if (!Number.isInteger(expectedCount) || expectedCount < 1) return null;

  const mins = oneMinuteByParent.get(strategyCandleTime);
  if (!mins || mins.length < expectedCount) return null;

  // Require exactly the chronological 1m slots belonging to this strategy candle.
  // Extra duplicate/out-of-window records are ignored only after timestamp matching.
  const byTime = new Map(mins.map(m => [Number(m.time), m]));
  const complete = [];
  for (let offset = 0; offset < parentSec; offset += 60) {
    const m = byTime.get(strategyCandleTime + offset);
    if (!m) return null;
    complete.push(m);
  }
  return complete;
}

function runBacktest(candles, p, oneMinuteByParent = new Map()) {
  // Strategy signals are generated only from strategy-timeframe candles.
  // The prebuilt 1m index is execution-only and is reused across optimizer trials.
  const closes = candles.map(c => c.close);
  const ema = computeEMA(closes, p.emaLen);
  const warmup = p.emaLen + p.slopeLookback + 2;

  let equity = p.startCapital;
  let peak = p.startCapital;
  let maxDD = 0;

  const equityCurve = [{ time: candles[Math.min(warmup, candles.length-1)] ? candles[warmup].time : candles[0].time, equity }];
  const trades = [];

  let pendingBuyTrigger = null, pendingBuySL = null, pendingBuySignalIndex = null;
  let pendingSellTrigger = null, pendingSellSL = null, pendingSellSignalIndex = null;
  let inTrade = false, tradeDir = null, entryPrice = null, slPrice = null, tpPrice = null, entryTime = null;
  let entryBarIndex = null, entryMinuteIndex = null, entryMinutes = null;

  let currentDay = null;
  let dailyLossStreak = 0;
  let dayBlocked = false;
  let tradesSkippedDueToLimit = 0;
  let tradesSkippedTightStop = 0;
  let tradesSkippedLeverage = 0;
  let tradesSkippedFees = 0;
  let entryAttemptsMissing1m = 0;
  let entryAttempts1mMismatch = 0;

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];

    const day = Math.floor(c.time / 86400);
    if (day !== currentDay) {
      currentDay = day;
      dailyLossStreak = 0;
      dayBlocked = false;
    }

    const e = ema[i];
    const ePrev = ema[i - p.slopeLookback];
    if (e == null || ePrev == null) continue;

    const trendUp = e > ePrev;
    const trendDown = e < ePrev;

    const buyPatternA = c.open < e && c.close > e;
    const buyPatternB = c.open > e && c.close > e && c.low <= e;
    const buySignalCandle = trendUp && (buyPatternA || buyPatternB);

    const sellPatternA = c.open > e && c.close < e;
    const sellPatternB = c.open < e && c.close < e && c.high >= e;
    const sellSignalCandle = trendDown && (sellPatternA || sellPatternB);

    // Entry Valid For Next Candles is controlled ONLY by strategy candles.
    // T0 cannot enter. With value=2, T1 and T2 are eligible; T3 is expired.
    if (!inTrade) {
      if (pendingBuySignalIndex != null && i - pendingBuySignalIndex > p.entryValidCandles) {
        pendingBuyTrigger = null; pendingBuySL = null; pendingBuySignalIndex = null;
      }
      if (pendingSellSignalIndex != null && i - pendingSellSignalIndex > p.entryValidCandles) {
        pendingSellTrigger = null; pendingSellSL = null; pendingSellSignalIndex = null;
      }
    }

    if (!inTrade && !dayBlocked) {
      const hasPendingSignal = pendingBuyTrigger != null || pendingSellTrigger != null;
      if (!hasPendingSignal && buySignalCandle) {
        pendingBuyTrigger = c.high; pendingBuySL = c.low; pendingBuySignalIndex = i;
        pendingSellTrigger = null; pendingSellSL = null; pendingSellSignalIndex = null;
      } else if (!hasPendingSignal && sellSignalCandle) {
        pendingSellTrigger = c.low; pendingSellSL = c.high; pendingSellSignalIndex = i;
        pendingBuyTrigger = null; pendingBuySL = null; pendingBuySignalIndex = null;
      }
    } else if (!inTrade && dayBlocked && (buySignalCandle || sellSignalCandle)) {
      tradesSkippedDueToLimit++;
    }

    // BUY: a strategy candle must break the trigger, then complete 1m data must confirm
    // the first strict trigger break. Missing/mismatched 1m data does NOT fabricate an
    // entry and does NOT consume the setup while another Entry Valid candle remains.
    if (!inTrade && !dayBlocked && pendingBuyTrigger != null && i > pendingBuySignalIndex && c.high > pendingBuyTrigger) {
      const candidateEntry = pendingBuyTrigger;
      const candidateSL = pendingBuySL;
      const mins = getCompleteExecutionMinutes(oneMinuteByParent, c.time, p.strategyResolutionSeconds);

      if (!mins) {
        entryAttemptsMissing1m++;
      } else {
        const confirmedEntryMinuteIndex = mins.findIndex(m => m.high > candidateEntry);
        if (confirmedEntryMinuteIndex < 0) {
          entryAttempts1mMismatch++;
        } else {
          const stopDistance = Math.abs(candidateEntry - candidateSL);
          const stopPct = candidateEntry > 0 ? (stopDistance / candidateEntry) * 100 : 0;
          const riskAmount = equity * (p.riskPct / 100);
          const riskBasedQty = stopDistance > 0 ? riskAmount / stopDistance : 0;
          const riskBasedNotional = riskBasedQty * candidateEntry;
          const effectiveLeverage = equity > 0 ? riskBasedNotional / equity : Infinity;
          const candidateTP = candidateEntry + stopDistance * p.rr;
          const estimatedEntryNotional = riskBasedNotional;
          const estimatedExitNotional = riskBasedQty * candidateTP;
          const estimatedBrokerCharge = (estimatedEntryNotional + estimatedExitNotional) * (p.commissionPct / 100);
          const estimatedGST = estimatedBrokerCharge * (p.gstPct / 100);
          const estimatedTotalCharges = estimatedBrokerCharge + estimatedGST;
          const feeRiskPct = riskAmount > 0 ? (estimatedTotalCharges / riskAmount) * 100 : Infinity;

          // A confirmed breakout consumes the setup even if an execution/risk guard rejects it.
          if (stopPct < p.minStopPct) {
            tradesSkippedTightStop++;
          } else if (effectiveLeverage > p.maxLeverage) {
            tradesSkippedLeverage++;
          } else if (feeRiskPct > p.maxFeeRiskPct) {
            tradesSkippedFees++;
          } else {
            inTrade = true; tradeDir = 'long';
            entryPrice = candidateEntry; slPrice = candidateSL; tpPrice = candidateTP;
            entryTime = mins[confirmedEntryMinuteIndex].time;
            entryBarIndex = i;
            entryMinuteIndex = confirmedEntryMinuteIndex;
            entryMinutes = mins;
          }

          pendingBuyTrigger = null; pendingBuySL = null; pendingBuySignalIndex = null;
        }
      }
    } else if (!inTrade && !dayBlocked && pendingSellTrigger != null && i > pendingSellSignalIndex && c.low < pendingSellTrigger) {
      const candidateEntry = pendingSellTrigger;
      const candidateSL = pendingSellSL;
      const mins = getCompleteExecutionMinutes(oneMinuteByParent, c.time, p.strategyResolutionSeconds);

      if (!mins) {
        entryAttemptsMissing1m++;
      } else {
        const confirmedEntryMinuteIndex = mins.findIndex(m => m.low < candidateEntry);
        if (confirmedEntryMinuteIndex < 0) {
          entryAttempts1mMismatch++;
        } else {
          const stopDistance = Math.abs(candidateEntry - candidateSL);
          const stopPct = candidateEntry > 0 ? (stopDistance / candidateEntry) * 100 : 0;
          const riskAmount = equity * (p.riskPct / 100);
          const riskBasedQty = stopDistance > 0 ? riskAmount / stopDistance : 0;
          const riskBasedNotional = riskBasedQty * candidateEntry;
          const effectiveLeverage = equity > 0 ? riskBasedNotional / equity : Infinity;
          const candidateTP = candidateEntry - stopDistance * p.rr;
          const estimatedEntryNotional = riskBasedNotional;
          const estimatedExitNotional = riskBasedQty * candidateTP;
          const estimatedBrokerCharge = (estimatedEntryNotional + estimatedExitNotional) * (p.commissionPct / 100);
          const estimatedGST = estimatedBrokerCharge * (p.gstPct / 100);
          const estimatedTotalCharges = estimatedBrokerCharge + estimatedGST;
          const feeRiskPct = riskAmount > 0 ? (estimatedTotalCharges / riskAmount) * 100 : Infinity;

          if (stopPct < p.minStopPct) {
            tradesSkippedTightStop++;
          } else if (effectiveLeverage > p.maxLeverage) {
            tradesSkippedLeverage++;
          } else if (feeRiskPct > p.maxFeeRiskPct) {
            tradesSkippedFees++;
          } else {
            inTrade = true; tradeDir = 'short';
            entryPrice = candidateEntry; slPrice = candidateSL; tpPrice = candidateTP;
            entryTime = mins[confirmedEntryMinuteIndex].time;
            entryBarIndex = i;
            entryMinuteIndex = confirmedEntryMinuteIndex;
            entryMinutes = mins;
          }

          pendingSellTrigger = null; pendingSellSL = null; pendingSellSignalIndex = null;
        }
      }
    }

    // On the entry strategy candle, protection starts from the 1m candle AFTER
    // the confirmed entry minute. Thus same-1m entry/SL ambiguity intentionally
    // resolves as entry first, with SL/TP becoming active on the next 1m candle.
    let exitReason = null, exitPrice = null, exitAt = null;
    if (inTrade) {
      if (entryBarIndex === i) {
        if (entryMinutes && entryMinuteIndex != null && entryMinuteIndex >= 0) {
          for (let mi = entryMinuteIndex + 1; mi < entryMinutes.length; mi++) {
            const m = entryMinutes[mi];
            if (tradeDir === 'long') {
              if (m.low <= slPrice) { exitReason = 'SL'; exitPrice = slPrice; exitAt = m.time; break; }
              if (m.high >= tpPrice) { exitReason = 'TP'; exitPrice = tpPrice; exitAt = m.time; break; }
            } else {
              if (m.high >= slPrice) { exitReason = 'SL'; exitPrice = slPrice; exitAt = m.time; break; }
              if (m.low <= tpPrice) { exitReason = 'TP'; exitPrice = tpPrice; exitAt = m.time; break; }
            }
          }
        }
      } else if (entryBarIndex == null || i > entryBarIndex) {
        // Later strategy candles: use fast strategy-TF OHLC when only one exit
        // level is reachable. If BOTH SL and TP are reachable in the same candle,
        // resolve their order with that candle's 1m candles chronologically.
        const slTouched = tradeDir === 'long' ? c.low <= slPrice : c.high >= slPrice;
        const tpTouched = tradeDir === 'long' ? c.high >= tpPrice : c.low <= tpPrice;

        if (slTouched && tpTouched) {
          // Reuse the same strict completeness check used for entry confirmation.
          // This avoids relying on an out-of-scope parentSec variable and also verifies
          // that every expected 1m timestamp exists inside this strategy candle.
          const mins = getCompleteExecutionMinutes(
            oneMinuteByParent,
            c.time,
            p.strategyResolutionSeconds
          );

          if (mins) {
            for (const m of mins) {
              const minuteSL = tradeDir === 'long' ? m.low <= slPrice : m.high >= slPrice;
              const minuteTP = tradeDir === 'long' ? m.high >= tpPrice : m.low <= tpPrice;

              // If both occur inside the SAME 1m candle, their intraminute order
              // is unknowable from OHLC, so SL wins by the agreed conservative rule.
              if (minuteSL && minuteTP) {
                exitReason = 'SL'; exitPrice = slPrice; exitAt = m.time; break;
              }
              if (minuteSL) {
                exitReason = 'SL'; exitPrice = slPrice; exitAt = m.time; break;
              }
              if (minuteTP) {
                exitReason = 'TP'; exitPrice = tpPrice; exitAt = m.time; break;
              }
            }
          }

          // A 5m candle says both levels were touched but its 1m set is incomplete
          // or inconsistent. Use the conservative SL-first fallback.
          if (!exitReason) {
            exitReason = 'SL'; exitPrice = slPrice; exitAt = c.time;
          }
        } else if (slTouched) {
          exitReason = 'SL'; exitPrice = slPrice; exitAt = c.time;
        } else if (tpTouched) {
          exitReason = 'TP'; exitPrice = tpPrice; exitAt = c.time;
        }
      }

      if (exitReason) {
        const rMultiple = exitReason === 'TP' ? p.rr : -1;
        const riskAmount = equity * (p.riskPct / 100);
        const grossPnL = rMultiple * riskAmount;
        const slDistance = Math.abs(entryPrice - slPrice);
        const positionQty = slDistance > 0 ? riskAmount / slDistance : 0;
        const entryNotional = positionQty * entryPrice;
        const exitNotional = positionQty * exitPrice;
        const brokerCharge = (entryNotional + exitNotional) * (p.commissionPct / 100);
        const gstCharge = brokerCharge * (p.gstPct / 100);
        const totalCharges = brokerCharge + gstCharge;
        const netPnL = grossPnL - totalCharges;
        const equityBeforeExit = equity;
        equity += netPnL;
        peak = Math.max(peak, equity);
        const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
        if (dd > maxDD) maxDD = dd;

        if (exitReason === 'SL') {
          dailyLossStreak++;
          if (dailyLossStreak >= p.maxLossesPerDay) dayBlocked = true;
        } else {
          dailyLossStreak = 0;
        }

        const netR = riskAmount > 0 ? netPnL / riskAmount : 0;
        const stopPct = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
        const effectiveLeverage = equityBeforeExit > 0 ? entryNotional / equityBeforeExit : 0;
        const feeRiskPct = riskAmount > 0 ? (totalCharges / riskAmount) * 100 : 0;

        trades.push({
          direction: tradeDir, entryTime, entryPrice, slPrice, tpPrice,
          exitTime: exitAt, exitPrice, exitReason, rMultiple, netR,
          grossPnL, brokerCharge, gstCharge, totalCharges, netPnL,
          stopPct, effectiveLeverage, feeRiskPct,
          equityAfter: equity, cumulativeNetProfit: equity - p.startCapital
        });
        equityCurve.push({ time: exitAt, equity });
        inTrade = false; tradeDir = null; entryBarIndex = null;
        entryMinuteIndex = null; entryMinutes = null;
      }
    }
  }

  const wins = trades.filter(t => t.exitReason === 'TP');
  const losses = trades.filter(t => t.exitReason === 'SL');
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  const totalReturn = (equity - p.startCapital) / p.startCapital * 100;
  const grossProfit = wins.reduce((s, t) => s + Math.max(t.netPnL, 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Math.min(t.netPnL, 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const grossAvgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const avgR = trades.length ? trades.reduce((s, t) => s + t.netR, 0) / trades.length : 0;
  const longTrades = trades.filter(t => t.direction === 'long');
  const shortTrades = trades.filter(t => t.direction === 'short');
  const totalGrossPnL = trades.reduce((s, t) => s + t.grossPnL, 0);
  const totalBrokerCharges = trades.reduce((s, t) => s + t.brokerCharge, 0);
  const totalGST = trades.reduce((s, t) => s + t.gstCharge, 0);
  const totalCharges = totalBrokerCharges + totalGST;
  const netProfit = equity - p.startCapital;

  return {
    trades, equityCurve,
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate, totalReturn, maxDD, profitFactor, avgR,
      finalEquity: equity,
      longCount: longTrades.length,
      shortCount: shortTrades.length,
      longWinRate: longTrades.length ? longTrades.filter(t => t.exitReason === 'TP').length / longTrades.length * 100 : 0,
      shortWinRate: shortTrades.length ? shortTrades.filter(t => t.exitReason === 'TP').length / shortTrades.length * 100 : 0,
      totalGrossPnL, totalBrokerCharges, totalGST, totalCharges, netProfit,
      grossAvgR,
      rrUsed: p.rr,
      riskPctUsed: p.riskPct,
      commissionPctUsed: p.commissionPct,
      gstPctUsed: p.gstPct,
      minStopPctUsed: p.minStopPct,
      maxLeverageUsed: p.maxLeverage,
      maxFeeRiskPctUsed: p.maxFeeRiskPct,
      maxLossesPerDayUsed: p.maxLossesPerDay,
      tradesSkippedDueToLimit,
      tradesSkippedTightStop,
      tradesSkippedLeverage,
      tradesSkippedFees,
      entryAttemptsMissing1m,
      entryAttempts1mMismatch,
    }
  };
}

// ============================================================
// RENDERING
// ============================================================
function fmt(n, d=2) { return Number(n).toLocaleString(undefined, {minimumFractionDigits:d, maximumFractionDigits:d}); }
function fmtDate(unix) { return new Date(unix*1000).toISOString().replace('T',' ').slice(0,16); }

function renderStats(stats) {
  const grid = document.getElementById('statsGrid');
  const cells = [
    ['RR Used', '1:'+fmt(stats.rrUsed,2), 'amber'],
    ['Risk / Trade', fmt(stats.riskPctUsed,2)+'%', ''],
    ['Broker Fee / Side', fmt(stats.commissionPctUsed,3)+'%', ''],
    ['GST on Fee', fmt(stats.gstPctUsed,1)+'%', ''],
    ['Min Stop', fmt(stats.minStopPctUsed,2)+'%', ''],
    ['Max Effective Leverage', fmt(stats.maxLeverageUsed,2)+'x', ''],
    ['Max Fee / Risk', fmt(stats.maxFeeRiskPctUsed,1)+'%', ''],
    ['Daily Loss Limit', stats.maxLossesPerDayUsed, ''],
    ['Total Trades', stats.totalTrades, ''],
    ['Win Rate', fmt(stats.winRate,1)+'%', stats.winRate>=50?'pos':'neg'],
    ['Total Return', (stats.totalReturn>=0?'+':'')+fmt(stats.totalReturn,2)+'%', stats.totalReturn>=0?'pos':'neg'],
    ['Max Drawdown', '-'+fmt(stats.maxDD,2)+'%', 'neg'],
    ['Profit Factor', stats.profitFactor===Infinity?'∞':fmt(stats.profitFactor,2), stats.profitFactor>=1.5?'pos':(stats.profitFactor<1?'neg':'amber')],
    ['Avg Net R / Trade', (stats.avgR>=0?'+':'')+fmt(stats.avgR,2)+'R', stats.avgR>=0?'pos':'neg'],
    ['Avg Gross R / Trade', (stats.grossAvgR>=0?'+':'')+fmt(stats.grossAvgR,2)+'R', stats.grossAvgR>=0?'pos':'neg'],
    ['Wins / Losses', `${stats.wins} / ${stats.losses}`, ''],
    ['Final Equity', '$'+fmt(stats.finalEquity,2), stats.totalReturn>=0?'pos':'neg'],
    ['Long Trades', `${stats.longCount} (${fmt(stats.longWinRate,0)}% win)`, ''],
    ['Short Trades', `${stats.shortCount} (${fmt(stats.shortWinRate,0)}% win)`, ''],
    ['Gross P&L (pre-charges)', '$'+fmt(stats.totalGrossPnL,2), stats.totalGrossPnL>=0?'pos':'neg'],
    ['Broker Charges Paid', '-$'+fmt(stats.totalBrokerCharges,2), 'neg'],
    ['GST Paid', '-$'+fmt(stats.totalGST,2), 'neg'],
    ['Net Profit (after charges)', (stats.netProfit>=0?'+':'-')+'$'+fmt(Math.abs(stats.netProfit),2), stats.netProfit>=0?'pos':'neg'],
    ['Setups Skipped (Daily Limit)', stats.tradesSkippedDueToLimit, 'amber'],
    ['Skipped: Stop Too Tight', stats.tradesSkippedTightStop, 'amber'],
    ['Skipped: Leverage Too High', stats.tradesSkippedLeverage, 'amber'],
    ['Skipped: Fees Too High', stats.tradesSkippedFees, 'amber'],
    ['Entry Attempts: Missing 1M Data', stats.entryAttemptsMissing1m, 'amber'],
    ['Entry Attempts: 5M/1M Mismatch', stats.entryAttempts1mMismatch, 'amber'],
  ];
  grid.innerHTML = cells.map(([label,val,cls]) =>
    `<div class="stat-cell"><div class="label">${label}</div><div class="value ${cls}">${val}</div></div>`
  ).join('');
  document.getElementById('results-panel').style.display = 'block';
}

function renderEquityCurve(equityCurve) {
  const canvas = document.getElementById('equity-canvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 280 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 280;
  ctx.clearRect(0,0,W,H);

  if (equityCurve.length < 2) return;
  const values = equityCurve.map(e => e.equity);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = 30;
  const range = (max - min) || 1;

  // grid lines
  ctx.strokeStyle = 'rgba(255,176,0,0.12)';
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){
    const y = pad + (H-2*pad) * (i/4);
    ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-10,y); ctx.stroke();
  }

  // equity line with glow
  ctx.shadowColor = '#ffb000';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = '#ffb000';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  equityCurve.forEach((pt, idx) => {
    const x = pad + (W - pad - 10) * (idx/(equityCurve.length-1));
    const y = H - pad - (H-2*pad) * ((pt.equity - min)/range);
    if (idx===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // labels
  ctx.fillStyle = '#a9987a';
  ctx.font = '11px JetBrains Mono';
  ctx.fillText('$'+fmt(max,0), 4, pad+4);
  ctx.fillText('$'+fmt(min,0), 4, H-pad+4);
}

function renderTradeLog(trades) {
  const body = document.getElementById('tradeLogBody');
  body.innerHTML = trades.map((t, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td class="tag-${t.direction}">${t.direction.toUpperCase()}</td>
      <td>${fmtDate(t.entryTime)}</td>
      <td>${fmt(t.entryPrice,1)}</td>
      <td>${fmt(t.slPrice,1)}</td>
      <td>${fmt(t.tpPrice,1)}</td>
      <td>${fmtDate(t.exitTime)}</td>
      <td>${fmt(t.exitPrice,1)}</td>
      <td class="tag-${t.exitReason.toLowerCase()}">${t.exitReason}</td>
      <td>${t.rMultiple>=0?'+':''}${fmt(t.rMultiple,2)}R</td>
      <td class="${t.netR>=0?'tag-tp':'tag-sl'}">${t.netR>=0?'+':''}${fmt(t.netR,2)}R</td>
      <td>${fmt(t.stopPct,3)}%</td>
      <td>${fmt(t.effectiveLeverage,2)}x</td>
      <td>${fmt(t.feeRiskPct,1)}%</td>
      <td class="${t.grossPnL>=0?'tag-tp':'tag-sl'}">${t.grossPnL>=0?'+':''}$${fmt(t.grossPnL,2)}</td>
      <td>-$${fmt(t.totalCharges,2)}</td>
      <td class="${t.netPnL>=0?'tag-tp':'tag-sl'}">${t.netPnL>=0?'+':''}$${fmt(t.netPnL,2)}</td>
      <td>$${fmt(t.equityAfter,2)}</td>
      <td class="${t.cumulativeNetProfit>=0?'tag-tp':'tag-sl'}">${t.cumulativeNetProfit>=0?'+':'-'}$${fmt(Math.abs(t.cumulativeNetProfit),2)}</td>
    </tr>
  `).join('');
  document.getElementById('log-panel').style.display = 'block';
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.style.display = 'block';
  box.textContent = msg;
}
function hideError() {
  document.getElementById('error-box').style.display = 'none';
}


// ============================================================
// PARAMETER OPTIMIZER
// ============================================================
let optimizerCancelRequested = false;
let optimizerBest = null;

function numericRange(min, max, step, integer = false) {
  min = Number(min); max = Number(max); step = Number(step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0) {
    throw new Error('Every optimizer range needs valid Min / Max / Step values.');
  }
  if (max < min) [min, max] = [max, min];

  const values = [];
  const eps = Math.abs(step) / 100000;
  for (let v = min; v <= max + eps; v += step) {
    values.push(integer ? Math.round(v) : Number(v.toFixed(10)));
    if (values.length > 10000) throw new Error('One optimizer range contains too many values.');
  }
  return [...new Set(values)];
}

function readBaseParams() {
  return {
    emaLen: parseInt(document.getElementById('emaLen').value, 10),
    slopeLookback: parseInt(document.getElementById('slopeLookback').value, 10),
    entryValidCandles: Math.max(1, parseInt(document.getElementById('entryValidCandles').value, 10) || 2),
    rr: parseFloat(document.getElementById('rr').value),
    riskPct: parseFloat(document.getElementById('riskPct').value),
    startCapital: parseFloat(document.getElementById('startCapital').value),
    commissionPct: parseFloat(document.getElementById('commissionPct').value),
    gstPct: parseFloat(document.getElementById('gstPct').value),
    maxLossesPerDay: parseInt(document.getElementById('maxLossesPerDay').value, 10),
    minStopPct: parseFloat(document.getElementById('minStopPct').value),
    maxLeverage: parseFloat(document.getElementById('maxLeverage').value),
    maxFeeRiskPct: parseFloat(document.getElementById('maxFeeRiskPct').value),
    strategyResolutionSeconds: resolutionToSeconds(document.getElementById('resolution').value),
  };
}

function readMarketInputs() {
  const symbol = document.getElementById('symbol').value.trim();
  const resolution = document.getElementById('resolution').value;
  const startUnix = Math.floor(new Date(document.getElementById('startDate').value + 'T00:00:00Z').getTime()/1000);
  const endUnix = Math.floor(new Date(document.getElementById('endDate').value + 'T23:59:59Z').getTime()/1000);
  return { symbol, resolution, startUnix, endUnix };
}

function buildOptimizerSpace() {
  return {
    emaLen: numericRange(
      document.getElementById('optEmaMin').value,
      document.getElementById('optEmaMax').value,
      document.getElementById('optEmaStep').value,
      true
    ),
    slopeLookback: numericRange(
      document.getElementById('optSlopeMin').value,
      document.getElementById('optSlopeMax').value,
      document.getElementById('optSlopeStep').value,
      true
    ),
    entryValidCandles: numericRange(
      document.getElementById('optEntryMin').value,
      document.getElementById('optEntryMax').value,
      document.getElementById('optEntryStep').value,
      true
    ),
    rr: numericRange(
      document.getElementById('optRrMin').value,
      document.getElementById('optRrMax').value,
      document.getElementById('optRrStep').value,
      false
    ),
    maxLossesPerDay: numericRange(
      document.getElementById('optLossMin').value,
      document.getElementById('optLossMax').value,
      document.getElementById('optLossStep').value,
      true
    ),
    minStopPct: numericRange(
      document.getElementById('optStopMin').value,
      document.getElementById('optStopMax').value,
      document.getElementById('optStopStep').value,
      false
    ),
    maxLeverage: numericRange(
      document.getElementById('optLevMin').value,
      document.getElementById('optLevMax').value,
      document.getElementById('optLevStep').value,
      false
    ),
    maxFeeRiskPct: numericRange(
      document.getElementById('optFeeMin').value,
      document.getElementById('optFeeMax').value,
      document.getElementById('optFeeStep').value,
      false
    ),
  };
}

function combinationCount(space) {
  return Object.values(space).reduce((n, arr) => n * arr.length, 1);
}

function comboFromIndex(space, idx) {
  const keys = Object.keys(space);
  const combo = {};
  let x = idx;
  for (let k = keys.length - 1; k >= 0; k--) {
    const key = keys[k];
    const arr = space[key];
    combo[key] = arr[x % arr.length];
    x = Math.floor(x / arr.length);
  }
  return combo;
}

function sampledIndices(total, maxTrials) {
  if (total <= maxTrials) return Array.from({length: total}, (_, i) => i);

  // Evenly spread deterministic samples over the full parameter space.
  // This is repeatable: the same ranges give the same tested combinations.
  const out = [];
  const used = new Set();
  const step = (total - 1) / Math.max(1, maxTrials - 1);
  for (let i = 0; i < maxTrials; i++) {
    let idx = Math.round(i * step);
    while (used.has(idx) && idx + 1 < total) idx++;
    if (!used.has(idx)) {
      used.add(idx);
      out.push(idx);
    }
  }
  return out;
}

function renderOptimizerResults(results, tested, totalPossible) {
  const topN = Math.max(1, parseInt(document.getElementById('optTopN').value, 10) || 25);
  const ranked = [...results].sort((a,b) => {
    if (b.stats.totalReturn !== a.stats.totalReturn) return b.stats.totalReturn - a.stats.totalReturn;
    if (a.stats.maxDD !== b.stats.maxDD) return a.stats.maxDD - b.stats.maxDD;
    return b.stats.profitFactor - a.stats.profitFactor;
  });

  optimizerBest = ranked[0] || null;
  bridge.ranked(index => index == null ? optimizerBest : (index >= 0 && index < topN ? ranked[index] || null : null));
  const resultsBox = document.getElementById('optimizer-results');
  const bestBox = document.getElementById('bestBox');
  const body = document.getElementById('optimizerTableBody');
  resultsBox.style.display = 'block';

  if (!optimizerBest) {
    bestBox.innerHTML = '<b>No eligible result.</b> Try lowering Minimum Trades Required or increasing Maximum Drawdown Allowed.';
    body.innerHTML = '';
    document.getElementById('applyBestBtn').disabled = true;
    return;
  }

  const b = optimizerBest;
  bestBox.innerHTML =
    `<b>BEST NET RETURN: ${b.stats.totalReturn >= 0 ? '+' : ''}${fmt(b.stats.totalReturn,2)}%</b>` +
    ` &nbsp;·&nbsp; Max DD ${fmt(b.stats.maxDD,2)}%` +
    ` &nbsp;·&nbsp; ${b.stats.totalTrades} trades` +
    ` &nbsp;·&nbsp; Win ${fmt(b.stats.winRate,1)}%` +
    ` &nbsp;·&nbsp; PF ${b.stats.profitFactor===Infinity?'∞':fmt(b.stats.profitFactor,2)}` +
    `<br>EMA ${b.params.emaLen} · Slope ${b.params.slopeLookback} · Entry Valid ${b.params.entryValidCandles}` +
    ` · RR 1:${b.params.rr} · Loss/Day ${b.params.maxLossesPerDay}` +
    ` · Min Stop ${b.params.minStopPct}% · Max Lev ${b.params.maxLeverage}x · Max Fee/Risk ${b.params.maxFeeRiskPct}%` +
    `<br>Tested ${tested.toLocaleString()} of ${totalPossible.toLocaleString()} possible combinations.`;

  body.innerHTML = ranked.slice(0, topN).map((r, i) => `
    <tr>
      <td>${i+1}</td>
      <td class="${r.stats.totalReturn>=0?'tag-tp':'tag-sl'}">${r.stats.totalReturn>=0?'+':''}${fmt(r.stats.totalReturn,2)}%</td>
      <td>${fmt(r.stats.maxDD,2)}%</td>
      <td>${r.stats.totalTrades}</td>
      <td>${fmt(r.stats.winRate,1)}%</td>
      <td>${r.stats.profitFactor===Infinity?'∞':fmt(r.stats.profitFactor,2)}</td>
      <td>${r.params.emaLen}</td>
      <td>${r.params.slopeLookback}</td>
      <td>${r.params.entryValidCandles}</td>
      <td>${fmt(r.params.rr,2)}</td>
      <td>${r.params.maxLossesPerDay}</td>
      <td>${fmt(r.params.minStopPct,2)}</td>
      <td>${fmt(r.params.maxLeverage,1)}x</td>
      <td>${fmt(r.params.maxFeeRiskPct,1)}%</td>
    </tr>
  `).join('');

  document.getElementById('applyBestBtn').disabled = false;
}

document.getElementById('optimizeBtn').addEventListener('click', async () => {
  bridge.begin();
  hideError();
  optimizerCancelRequested = false;
  optimizerBest = null;

  const optimizeBtn = document.getElementById('optimizeBtn');
  const cancelBtn = document.getElementById('optCancelBtn');
  const applyBestBtn = document.getElementById('applyBestBtn');
  const progressBar = document.getElementById('optProgressBar');
  const progressText = document.getElementById('optProgressText');

  optimizeBtn.disabled = true;
  cancelBtn.disabled = false;
  applyBestBtn.disabled = true;
  document.getElementById('optimizer-results').style.display = 'none';

  try {
    const market = readMarketInputs();
    const base = readBaseParams();
    const space = buildOptimizerSpace();
    const totalPossible = combinationCount(space);
    const maxTrials = Math.max(1, parseInt(document.getElementById('optMaxTrials').value, 10) || 3000);
    const minTrades = Math.max(1, parseInt(document.getElementById('optMinTrades').value, 10) || 1);
    const maxDDAllowed = Math.max(0, parseFloat(document.getElementById('optMaxDD').value) || 0);

    progressText.textContent = 'Fetching candles once for optimization...';
    const candles = await fetchCandles(
      market.symbol, market.resolution, market.startUnix, market.endUnix,
      (pct, count) => {
        progressBar.style.width = (pct * 0.20).toFixed(1) + '%';
        progressText.textContent = `Fetching... ${pct.toFixed(1)}% (${count.toLocaleString()} candles)`;
      }
    );

    progressText.textContent = 'Fetching 1-minute execution candles once for optimization...';
    const oneMinuteCandles = await fetchCandles(
      market.symbol, '1m', market.startUnix, market.endUnix,
      (pct, count) => {
        progressBar.style.width = (20 + pct * 0.20).toFixed(1) + '%';
        progressText.textContent = `Fetching 1m execution data... ${pct.toFixed(1)}% (${count.toLocaleString()} candles)`;
      }
    );

    progressText.textContent = 'Indexing 1-minute execution candles once...';
    const oneMinuteByParent = buildOneMinuteIndex(oneMinuteCandles, base.strategyResolutionSeconds);

    const largestEma = Math.max(...space.emaLen);
    const largestSlope = Math.max(...space.slopeLookback);
    if (candles.length < largestEma + largestSlope + 5) {
      throw new Error(`Only ${candles.length} candles returned — not enough for the largest optimizer EMA/lookback.`);
    }

    const indices = sampledIndices(totalPossible, maxTrials);
    const eligible = [];

    for (let n = 0; n < indices.length; n++) {
      if (optimizerCancelRequested || cancelRequested) throw new Error('Optimization cancelled by user.');

      const combo = comboFromIndex(space, indices[n]);
      const params = { ...base, ...combo };
      const result = runBacktest(candles, params, oneMinuteByParent);

      if (result.stats.totalTrades >= minTrades && result.stats.maxDD <= maxDDAllowed) {
        eligible.push({ params, stats: result.stats });
      }

      if (n % 10 === 0 || n === indices.length - 1) {
        const simPct = ((n + 1) / indices.length) * 60;
        progressBar.style.width = (40 + simPct).toFixed(1) + '%';
        progressText.textContent =
          `Optimizing ${n+1}/${indices.length} trials · ${eligible.length} eligible · ` +
          `${totalPossible.toLocaleString()} possible combinations`;

        // Yield to the browser so Cancel works and the page stays responsive.
        await new Promise(r => setTimeout(r, 0));
      }
    }

    renderOptimizerResults(eligible, indices.length, totalPossible);
    bridge.complete(optimizerCancelRequested || cancelRequested);
    progressBar.style.width = '100%';
    progressText.textContent =
      `Optimization complete — ${indices.length.toLocaleString()} combinations tested, ` +
      `${eligible.length.toLocaleString()} passed filters.`;
  } catch (err) {
    showError(err.message || String(err));
    bridge.invalidate();
    progressText.textContent = 'Optimization stopped — see message above.';
  } finally {
    optimizeBtn.disabled = false;
    cancelBtn.disabled = true;
  }
});

document.getElementById('optCancelBtn').addEventListener('click', () => {
  bridge.invalidate();
  optimizerCancelRequested = true;
});

document.getElementById('applyBestBtn').addEventListener('click', () => {
  if (!optimizerBest) return;
  const finishApply = bridge.applyingBest(optimizerBest);
  const p = optimizerBest.params;
  document.getElementById('emaLen').value = p.emaLen;
  document.getElementById('slopeLookback').value = p.slopeLookback;
  document.getElementById('entryValidCandles').value = p.entryValidCandles;
  document.getElementById('rr').value = p.rr;
  document.getElementById('maxLossesPerDay').value = p.maxLossesPerDay;
  document.getElementById('minStopPct').value = p.minStopPct;
  document.getElementById('maxLeverage').value = p.maxLeverage;
  document.getElementById('maxFeeRiskPct').value = p.maxFeeRiskPct;
  document.getElementById('optProgressText').textContent =
    'Best optimizer values copied to Configuration. Click Run Backtest to inspect the full trade log and equity curve.';
  finishApply();
});


// ============================================================
// MAIN
// ============================================================
document.getElementById('runBtn').addEventListener('click', async () => {
  hideError();
  cancelRequested = false;
  const runBtn = document.getElementById('runBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  runBtn.disabled = true;
  cancelBtn.disabled = false;

  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('equity-panel').style.display = 'none';
  document.getElementById('log-panel').style.display = 'none';

  const symbol = document.getElementById('symbol').value.trim();
  const resolution = document.getElementById('resolution').value;
  const startUnix = Math.floor(new Date(document.getElementById('startDate').value + 'T00:00:00Z').getTime()/1000);
  const endUnix = Math.floor(new Date(document.getElementById('endDate').value + 'T23:59:59Z').getTime()/1000);

  const params = {
    emaLen: parseInt(document.getElementById('emaLen').value, 10),
    slopeLookback: parseInt(document.getElementById('slopeLookback').value, 10),
    entryValidCandles: Math.max(1, parseInt(document.getElementById('entryValidCandles').value, 10) || 2),
    rr: parseFloat(document.getElementById('rr').value),
    riskPct: parseFloat(document.getElementById('riskPct').value),
    startCapital: parseFloat(document.getElementById('startCapital').value),
    commissionPct: parseFloat(document.getElementById('commissionPct').value),
    gstPct: parseFloat(document.getElementById('gstPct').value),
    maxLossesPerDay: parseInt(document.getElementById('maxLossesPerDay').value, 10),
    minStopPct: parseFloat(document.getElementById('minStopPct').value),
    maxLeverage: parseFloat(document.getElementById('maxLeverage').value),
    maxFeeRiskPct: parseFloat(document.getElementById('maxFeeRiskPct').value),
    strategyResolutionSeconds: resolutionToSeconds(document.getElementById('resolution').value),
  };

  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');

  try {
    progressText.textContent = 'Fetching candles...';
    const candles = await fetchCandles(symbol, resolution, startUnix, endUnix, (pct, count) => {
      progressBar.style.width = pct.toFixed(1) + '%';
      progressText.textContent = `Fetching... ${pct.toFixed(1)}% (${count.toLocaleString()} candles loaded)`;
    });

    if (candles.length < params.emaLen + params.slopeLookback + 5) {
      throw new Error(`Only ${candles.length} candles returned — not enough for a ${params.emaLen}-period EMA. Try a wider date range.`);
    }

    progressText.textContent = 'Fetching 1-minute candles for intrabar execution...';
    const oneMinuteCandles = await fetchCandles(symbol, '1m', startUnix, endUnix, (pct, count) => {
      progressBar.style.width = pct.toFixed(1) + '%';
      progressText.textContent = `Fetching 1m execution data... ${pct.toFixed(1)}% (${count.toLocaleString()} candles loaded)`;
    });

    progressText.textContent = 'Indexing 1-minute execution candles once...';
    const oneMinuteByParent = buildOneMinuteIndex(oneMinuteCandles, params.strategyResolutionSeconds);

    progressText.textContent = `Simulating strategy over ${candles.length.toLocaleString()} strategy candles with ${oneMinuteCandles.length.toLocaleString()} 1m execution candles...`;
    await new Promise(r => setTimeout(r, 30)); // let UI paint

    const result = runBacktest(candles, params, oneMinuteByParent);

    renderStats(result.stats);
    document.getElementById('equity-panel').style.display = 'block';
    renderEquityCurve(result.equityCurve);
    renderTradeLog(result.trades);

    progressBar.style.width = '100%';
    progressText.textContent = `Done. ${candles.length.toLocaleString()} candles, ${result.trades.length} trades. RR 1:${params.rr} · Risk ${params.riskPct}% · Max Lev ${params.maxLeverage}x · Min Stop ${params.minStopPct}% · Max Fee/Risk ${params.maxFeeRiskPct}%`;
  } catch (err) {
    showError(err.message || String(err));
    progressText.textContent = 'Failed — see error above.';
  } finally {
    runBtn.disabled = false;
    cancelBtn.disabled = true;
  }
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  cancelRequested = true;
});

return { dispose() { cancelRequested = true; optimizerCancelRequested = true; bridge.invalidate(); }, readMarketInputs };
}
