import { config } from './lib/config';
import { emaSeries, evaluateSetup } from './lib/strategy';
import { getCandles, getProduct, getTicker, getWallet, getPosition, getOpenOrders, placeMarketOrder, placeBracket, setLeverage } from './lib/delta';
import { readControl, writeStatus } from './lib/state';

let product:any = null;
let pending:any = null;
let lastSetupCandle = 0;
let previousPositionSize = 0;
let activeTrade:any = null;
let currentDay = '';
let lossStreak = 0;
let uiLogs:any[] = [];
let tradeEvents:any[] = [];
let lastBracketSyncAt = 0;
let connectionState:'online'|'offline' = 'online';
let lastOnlineAt:string|null = null;
let lastOfflineAt:string|null = null;
let connectionError:string|null = null;
let consecutiveNetworkFailures = 0;

// Cached data. The ticker remains fast (POLL_MS), while slower REST calls are throttled.
let completedCandles:any[] = [];
let candleBucket = -1;
let lastCandleFetchAt = 0;
let cachedWallet:any = null;
let cachedEquity = 0;
let cachedAvailable = 0;
let lastWalletFetchAt = 0;
let cachedPosition:any = null;
let cachedPositionSize = 0;
let lastPositionFetchAt = 0;

const POSITION_REFRESH_MS = 5_000;
const WALLET_REFRESH_MS = 30_000;
const CANDLE_CLOSE_GRACE_SEC = 2;
const BRACKET_SYNC_MS = 5_000;

function upsertUiLog(candleTime:number, patch:any) {
  const i = uiLogs.findIndex((x:any) => x.candleTime === candleTime);
  if (i >= 0) uiLogs[i] = { ...uiLogs[i], ...patch };
  else uiLogs.unshift({ candleTime, ...patch });
  uiLogs = uiLogs.slice(0, 60);
}

function addTradeEvent(type:string, details:any = {}) {
  tradeEvents.unshift({ id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, at:new Date().toISOString(), type, ...details });
  tradeEvents = tradeEvents.slice(0, 100);
}

function numeric(v:any):number|null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readBracketPrices(orders:any[]) {
  let sl:number|null = null;
  let tp:number|null = null;
  for (const o of orders || []) {
    const orderSl = numeric(o?.bracket_stop_loss_price);
    const orderTp = numeric(o?.bracket_take_profit_price);
    if (orderSl != null) sl = orderSl;
    if (orderTp != null) tp = orderTp;

    const stopPrice = numeric(o?.stop_price);
    if (stopPrice != null && o?.stop_order_type === 'stop_loss_order') sl = stopPrice;
    if (stopPrice != null && o?.stop_order_type === 'take_profit_order') tp = stopPrice;
  }
  return { sl, tp };
}

async function syncExchangeBracket(force = false) {
  if (!product || !activeTrade || cachedPositionSize === 0) return;
  const now = Date.now();
  if (!force && lastBracketSyncAt > 0 && now - lastBracketSyncAt < BRACKET_SYNC_MS) return;
  lastBracketSyncAt = now;

  const orders = await getOpenOrders(Number(product.id));
  const live = readBracketPrices(orders);
  const oldSl = numeric(activeTrade.sl);
  const oldTp = numeric(activeTrade.tp);

  if (live.sl !== oldSl) {
    activeTrade.sl = live.sl;
    addTradeEvent(live.sl == null ? 'SL_REMOVED_ON_EXCHANGE' : 'SL_SYNCED_FROM_EXCHANGE', { oldValue:oldSl, newValue:live.sl });
  }
  if (live.tp !== oldTp) {
    activeTrade.tp = live.tp;
    addTradeEvent(live.tp == null ? 'TP_REMOVED_ON_EXCHANGE' : 'TP_SYNCED_FROM_EXCHANGE', { oldValue:oldTp, newValue:live.tp });
  }
  activeTrade.exchangeSync = { at:new Date().toISOString(), sl:live.sl, tp:live.tp };
}

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const roundToTick=(price:number,tick:number)=>Math.round(price/tick)*tick;

async function refreshWallet(force = false) {
  const now = Date.now();
  if (!force && lastWalletFetchAt > 0 && now - lastWalletFetchAt < WALLET_REFRESH_MS) return;

  cachedWallet = await getWallet();
  cachedEquity = Number(cachedWallet?.meta?.net_equity || cachedWallet?.meta?.robo_trading_equity || 0);
  const usd = (cachedWallet?.result || []).find((w:any)=>w.asset_symbol === 'USD') || (cachedWallet?.result || [])[0];
  cachedAvailable = Number(usd?.available_balance_for_robo || usd?.available_balance || 0);
  lastWalletFetchAt = now;
}

async function refreshPosition(lastPrice:number, force = false) {
  const now = Date.now();
  if (!force && lastPositionFetchAt > 0 && now - lastPositionFetchAt < POSITION_REFRESH_MS) return;

  const position = await getPosition(Number(product.id));
  const positionSize = Number(position?.size || 0);

  // If the app starts while an XAUTUSD position is already open on Delta,
  // adopt that exchange position into the UI/state instead of treating it as
  // an unknown blocker. Delta remains the source of truth for its live size,
  // entry price and bracket orders. No new setup/entry is allowed while it exists.
  if (positionSize !== 0 && !activeTrade) {
    const direction = positionSize > 0 ? 'long' : 'short';
    activeTrade = {
      direction,
      entryPrice:Number(position?.entry_price || 0),
      sl:null,
      tp:null,
      contracts:Math.abs(positionSize),
      positionSize,
      orderId:null,
      openedAt:null,
      source:'exchange_existing',
      adoptedAt:Date.now(),
      exchangeSync:null
    };
    pending = null;
    addTradeEvent('EXCHANGE_POSITION_ADOPTED', {
      direction,
      positionSize,
      entryPrice:Number(position?.entry_price || 0),
      source:'EXISTING_DELTA_POSITION'
    });
  }

  // Preserve the existing closed-trade streak logic for bot-created trades.
  // A position that existed before app startup is synchronized and displayed,
  // but its result is not added to the bot's daily loss streak.
  if (previousPositionSize !== 0 && positionSize === 0 && activeTrade) {
    const tp = numeric(activeTrade.tp);
    const isAdopted = activeTrade.source === 'exchange_existing';
    const won = tp != null ? (activeTrade.direction === 'long' ? lastPrice >= tp : lastPrice <= tp) : false;
    if (!isAdopted) {
      if (won) lossStreak = 0;
      else lossStreak += 1;
    }
    addTradeEvent('POSITION_CLOSED', {
      direction:activeTrade.direction,
      lastPrice,
      syncedTp:tp,
      source:isAdopted?'EXISTING_DELTA_POSITION':'BOT',
      classifiedAs:isAdopted?'EXTERNAL_POSITION_CLOSED':(won?'WIN':'LOSS_OR_MANUAL_CLOSE')
    });
    activeTrade = null;
  }

  // Keep the adopted/live trade details synchronized with the current Delta position.
  if (positionSize !== 0 && activeTrade) {
    activeTrade.positionSize = positionSize;
    activeTrade.contracts = Math.abs(positionSize);
    activeTrade.entryPrice = Number(position?.entry_price || activeTrade.entryPrice || 0);
  }

  cachedPosition = position;
  cachedPositionSize = positionSize;
  previousPositionSize = positionSize;
  lastPositionFetchAt = now;
}

async function refreshCandlesIfNeeded(nowSec:number) {
  const candleSec = config.resolutionSec;
  const bucket = Math.floor(nowSec / candleSec);
  const secondIntoBucket = nowSec % candleSec;

  // Initial load happens immediately. After that, refresh only when a new
  // RESOLUTION bucket has started. Give Delta a short grace period to publish the closed bar.
  if (completedCandles.length > 0 && bucket === candleBucket) return false;
  if (completedCandles.length > 0 && secondIntoBucket < CANDLE_CLOSE_GRACE_SEC) return false;

  const previousLatestTime = completedCandles.length
    ? Number(completedCandles[completedCandles.length - 1]?.time || 0)
    : 0;

  // Fetch enough history for EMA warm-up. 180 bars was too short for EMA100
  // and could leave a meaningful seed error versus Delta's long-history chart.
  const candlesRaw = await getCandles(config.symbol, config.resolution, config.candleHistoryBars);
  const candles = candlesRaw.map((c:any)=>({
    time:Number(c.time),
    open:Number(c.open),
    high:Number(c.high),
    low:Number(c.low),
    close:Number(c.close)
  }));

  const completed = candles.filter((c:any) => c.time + candleSec <= nowSec);
  const latestTime = completed.length ? Number(completed[completed.length - 1]?.time || 0) : 0;
  lastCandleFetchAt = Date.now();

  if (completedCandles.length === 0) {
    completedCandles = completed;
    candleBucket = bucket;
    return true;
  }

  // If the exchange has not published the newly completed candle yet, keep the
  // previous bucket marker so the next fast cycle retries instead of waiting a full candle.
  if (latestTime <= previousLatestTime) return false;

  completedCandles = completed;
  candleBucket = bucket;
  return true;
}

async function cycle() {
  // The dashboard control is the master switch for NEW algo entries.
  // Monitoring stays alive even when the robot is stopped so an already-open
  // Delta position, its SL/TP and its eventual close continue to update on UI.
  const control = readControl();
  const tradingEnabled = control.running === true;

  product ||= await getProduct(config.symbol);
  if (!product || product.state !== 'live' || product.trading_status !== 'operational') {
    throw new Error(`Product ${config.symbol} is not operational`);
  }

  // Fast path: ticker is fetched every POLL_MS so breakout detection remains fast.
  const ticker = await getTicker(config.symbol);
  const lastTradedPrice = Number(ticker.close ?? 0);
  const markPrice = Number(ticker.mark_price ?? 0);
  const spotPrice = Number(ticker.spot_price ?? 0);
  const lastPrice = config.priceSource === 'last'
    ? (lastTradedPrice || markPrice || spotPrice)
    : config.priceSource === 'spot'
      ? (spotPrice || markPrice || lastTradedPrice)
      : (markPrice || lastTradedPrice || spotPrice);

  const nowSec = Math.floor(Date.now()/1000);
  const day = new Date().toISOString().slice(0,10);
  if (day !== currentDay) {
    currentDay = day;
    lossStreak = 0;
  }

  // Slower data is refreshed independently from the 1-second breakout check.
  await refreshPosition(lastPrice);
  await syncExchangeBracket();
  await refreshWallet();
  const candlesChanged = await refreshCandlesIfNeeded(nowSec);

  const latest = completedCandles[completedCandles.length - 1];
  const equity = cachedEquity;
  const available = cachedAvailable;
  const riskBase = available;
  const positionSize = cachedPositionSize;

  let emaCurrent:number|null = null;
  let emaPrevious:number|null = null;
  let trendUp = false;
  let trendDown = false;
  let buyPatternA = false;
  let buyPatternB = false;
  let sellPatternA = false;
  let sellPatternB = false;

  if (completedCandles.length > 0) {
    const emaValues = emaSeries(completedCandles.map(c => c.close), config.emaLen);
    const latestIndex = completedCandles.length - 1;
    emaCurrent = latestIndex >= 0 ? emaValues[latestIndex] : null;
    emaPrevious = latestIndex - config.slopeLookback >= 0 ? emaValues[latestIndex - config.slopeLookback] : null;
    trendUp = emaCurrent != null && emaPrevious != null ? emaCurrent > emaPrevious : false;
    trendDown = emaCurrent != null && emaPrevious != null ? emaCurrent < emaPrevious : false;
    buyPatternA = !!latest && emaCurrent != null && latest.open < emaCurrent && latest.close > emaCurrent;
    buyPatternB = !!latest && emaCurrent != null && latest.open > emaCurrent && latest.close > emaCurrent && latest.low < emaCurrent;
    sellPatternA = !!latest && emaCurrent != null && latest.open > emaCurrent && latest.close < emaCurrent;
    sellPatternB = !!latest && emaCurrent != null && latest.open < emaCurrent && latest.close < emaCurrent && latest.high > emaCurrent;
  }

  let decision:any = { action:'WAIT' };

  // STOP ROBOT disables NEW algo execution only. Market/candle analysis and the
  // completed-candle Decision Log must continue normally while stopped. Any pending
  // executable setup is cleared so START waits for a new completed signal candle.
  if (!tradingEnabled) {
    pending = null;
  }

  // Always analyse and log every newly completed RESOLUTION candle, even when:
  //   - ROBOT is stopped, or
  //   - an XAUTUSD position is already open.
  // Only creation of an executable pending setup depends on tradingEnabled and
  // the one-position-at-a-time / daily-loss guards.
  if (candlesChanged && latest && latest.time !== lastSetupCandle) {
    const s = evaluateSetup(completedCandles, config.emaLen, config.slopeLookback);
    lastSetupCandle = latest.time;

    if (tradingEnabled && positionSize === 0 && lossStreak < config.maxDailyLosses) {
      if (s) pending = s;
    }

    let candleDecision:any;
    if (!tradingEnabled) {
      candleDecision = cachedPositionSize !== 0
        ? { action:'STOPPED', reason:'POSITION_STILL_OPEN' }
        : { action:'STOPPED', reason:'ROBOT_STOPPED' };
      decision = candleDecision;
    } else if (positionSize !== 0) {
      candleDecision = { action:'WAIT', reason:'EXISTING_POSITION' };
    } else if (lossStreak >= config.maxDailyLosses) {
      candleDecision = { action:'WAIT', reason:'DAILY_LOSS_LIMIT' };
    } else {
      candleDecision = { action:'WAIT', reason:s ? 'WAITING_FOR_BREAKOUT' : 'NO_VALID_SETUP' };
    }

    upsertUiLog(latest.time, {
      loggedAt:new Date().toISOString(),
      candle:{ open:latest.open, high:latest.high, low:latest.low, close:latest.close },
      price:{ source:config.priceSource, candleSource:'traded_price', strategy:lastPrice, mark:markPrice, last:lastTradedPrice, spot:spotPrice },
      ema:{ current:emaCurrent, previous:emaPrevious, lookback:config.slopeLookback, direction:trendUp?'UP':trendDown?'DOWN':'FLAT/UNKNOWN' },
      buy:{ slope:trendUp, patternA:buyPatternA, patternB:buyPatternB, setup:trendUp && (buyPatternA || buyPatternB) },
      sell:{ slope:trendDown, patternA:sellPatternA, patternB:sellPatternB, setup:trendDown && (sellPatternA || sellPatternB) },
      setup:s ? { direction:s.direction, trigger:s.trigger, sl:s.sl } : null,
      account:{ equity, available, riskBase:'available', riskPct:config.riskPct, positionSize, lossStreak },
      decision:candleDecision
    });
  }

  if (tradingEnabled && pending && positionSize === 0 && lossStreak < config.maxDailyLosses) {
    const breakout = pending.direction === 'long'
      ? lastPrice > pending.trigger
      : lastPrice < pending.trigger;

    if (!breakout && latest) {
      upsertUiLog(latest.time, {
        breakout:{ direction:pending.direction, trigger:pending.trigger, currentPrice:lastPrice, passed:false },
        decision:{ action:'WAIT', reason:'WAITING_FOR_BREAKOUT' }
      });
    }

    if (breakout) {
      // Re-check the real position immediately before sizing/ordering so a stale
      // 5-second position cache can never create a duplicate entry.
      await refreshPosition(lastPrice, true);

      if (cachedPositionSize !== 0) {
        decision = { action:'WAIT', reason:'EXISTING_POSITION' };
      } else {
        // Risk must use the freshest Delta available margin at the breakout.
        await refreshWallet(true);

        const freshEquity = cachedEquity;
        const freshAvailable = cachedAvailable;
        const freshRiskBase = freshAvailable;
        const stopDistance = Math.abs(pending.trigger - pending.sl);
        const stopPct = stopDistance / pending.trigger * 100;
        const riskAmount = freshRiskBase * config.riskPct / 100;
        const baseQty = stopDistance > 0 ? riskAmount / stopDistance : 0;
        const contractValue = Number(product.contract_value);
        const contracts = Math.floor(baseQty / contractValue);
        const notional = contracts * contractValue * pending.trigger;

        // Available margin is the bot's actual usable capital/risk base, so use
        // the same base for the bot's effective-leverage safety check.
        const effectiveLeverage = freshRiskBase > 0 ? notional / freshRiskBase : Infinity;

        const tpRaw = pending.direction === 'long'
          ? pending.trigger + stopDistance*config.rr
          : pending.trigger - stopDistance*config.rr;
        const tick = Number(product.tick_size || 0.01);
        const tp = roundToTick(tpRaw, tick);
        const sl = roundToTick(pending.sl, tick);
        const takerRate = Number(product.taker_commission_rate ?? 0.0005);
        const exitNotional = contracts * contractValue * tp;
        const feeBeforeGST = (notional + exitNotional) * takerRate;
        const estimatedFees = feeBeforeGST * (1 + config.gstPct/100);
        const feeRiskPct = riskAmount > 0 ? estimatedFees/riskAmount*100 : Infinity;

        let reject = '';
        if (contracts < 1) reject = 'SIZE_BELOW_ONE_CONTRACT';
        else if (stopPct < config.minStopPct) reject = 'STOP_TOO_TIGHT';
        else if (effectiveLeverage > config.maxEffectiveLeverage) reject = 'LEVERAGE_TOO_HIGH';
        else if (feeRiskPct > config.maxFeeRiskPct) reject = 'FEES_TOO_HIGH';

        decision = {
          action: reject ? 'SKIP' : 'ENTRY',
          reason: reject || undefined,
          direction:pending.direction,
          trigger:pending.trigger,
          sl,
          tp,
          contracts,
          riskAmount,
          stopPct,
          effectiveLeverage,
          feeRiskPct,
          estimatedFees
        };

        if (latest) {
          upsertUiLog(latest.time, {
            breakout:{ direction:pending.direction, trigger:pending.trigger, currentPrice:lastPrice, passed:true },
            risk:{
              equity:freshEquity,
              available:freshAvailable,
              riskBase:freshRiskBase,
              riskPct:config.riskPct,
              riskAmount,
              entry:pending.trigger,
              sl,
              stopDistance,
              stopPct,
              rr:config.rr,
              tp,
              contractValue,
              contracts,
              notional,
              effectiveLeverage,
              maxEffectiveLeverage:config.maxEffectiveLeverage,
              takerRate,
              feeBeforeGST,
              gstPct:config.gstPct,
              estimatedFees,
              feeRiskPct,
              maxFeeRiskPct:config.maxFeeRiskPct
            },
            decision:{
              action:reject ? 'SKIP' : (config.autoTrade ? 'ENTRY' : 'SKIP'),
              reason:reject || (!config.autoTrade ? 'AUTO_TRADE_FALSE' : 'TRADE_APPROVED')
            }
          });
        }

        if (!reject && config.autoTrade) {
          // IMPORTANT: the user may click STOP while this cycle is already in progress.
          // Re-read the control file immediately before any exchange-side action.
          // This closes the race where the cycle started as RUNNING and could otherwise
          // submit an order after the STOP button had already been pressed.
          if (!readControl().running) {
            decision = { action:'STOPPED', reason:'ROBOT_STOPPED_BEFORE_ORDER' };
            if (latest) upsertUiLog(latest.time, { decision:{ action:'STOPPED', reason:'ROBOT_STOPPED_BEFORE_ORDER' } });
            addTradeEvent('ORDER_BLOCKED_ROBOT_STOPPED', { direction:pending.direction, trigger:pending.trigger });
          } else {
            await setLeverage(Number(product.id), Math.min(config.orderLeverage, config.maxEffectiveLeverage));

            // Check once more after the leverage REST request and immediately before
            // the MARKET order. No new order is allowed once STOP has been pressed.
            if (!readControl().running) {
              decision = { action:'STOPPED', reason:'ROBOT_STOPPED_BEFORE_ORDER' };
              if (latest) upsertUiLog(latest.time, { decision:{ action:'STOPPED', reason:'ROBOT_STOPPED_BEFORE_ORDER' } });
              addTradeEvent('ORDER_BLOCKED_ROBOT_STOPPED', { direction:pending.direction, trigger:pending.trigger });
            } else {
              const side = pending.direction === 'long' ? 'buy' : 'sell';
              const oid = `ema-${Date.now()}`.slice(0,32);
              const order = await placeMarketOrder(Number(product.id), side, contracts, oid);
              if (latest) upsertUiLog(latest.time, { order:{ market:'SENT', side, orderId:order?.result?.id ?? null }, decision:{ action:'ENTRY', reason:'ORDER_SENT' }, entryEvent:true });
              addTradeEvent('ORDER_SENT', { side:side.toUpperCase(), orderId:order?.result?.id ?? null, direction:pending.direction, trigger:pending.trigger, sl, tp, contracts, breakoutPrice:lastPrice });

              // Once the market order has already been sent, STOP must NOT prevent
              // protective SL/TP placement. Protecting the open position takes priority.
              await sleep(700);
              const triggerMethod = config.priceSource === 'mark'
                ? 'mark_price'
                : config.priceSource === 'spot'
                  ? 'spot_price'
                  : 'last_traded_price';
              await placeBracket(Number(product.id), sl, tp, triggerMethod);

              if (latest) {
                upsertUiLog(latest.time, {
                  order:{ market:'SENT', side, orderId:order?.result?.id ?? null, bracket:'SENT', sl, tp },
                  decision:{ action:'ENTRY', reason:'ALGO_POSITION_OPEN' },
                  entryEvent:true
                });
              }

              activeTrade = { direction:pending.direction, entryPrice:pending.trigger, sl, tp, contracts, positionSize:pending.direction === 'long' ? contracts : -contracts, orderId:order?.result?.id, openedAt:Date.now(), source:'bot', exchangeSync:null };
              addTradeEvent('BRACKET_SENT', { orderId:order?.result?.id ?? null, sl, tp, triggerMethod });

              // Force a fresh position snapshot on the next cycle.
              lastPositionFetchAt = 0;
            }
          }
        }

        // Preserve existing behavior: once the trigger has broken, either the
        // trade is placed or rejected by safety filters, and the pending setup ends.
        pending = null;
      }
    }
  }

  if (decision.action === 'WAIT') {
    let waitReason = 'NO_VALID_SETUP';
    if (cachedPositionSize !== 0) waitReason = 'EXISTING_POSITION';
    else if (lossStreak >= config.maxDailyLosses) waitReason = 'DAILY_LOSS_LIMIT';
    else if (pending) waitReason = 'WAITING_FOR_BREAKOUT';
    if (latest) {
      const existing = uiLogs.find((x:any) => x.candleTime === latest.time);
      if (!existing?.entryEvent) upsertUiLog(latest.time, { decision:{ action:'WAIT', reason:waitReason } });
    }
  }

  const latestControl = readControl();
  const robotRunningNow = latestControl.running === true;

  const recovered = connectionState === 'offline';
  connectionState = 'online';
  lastOnlineAt = new Date().toISOString();
  connectionError = null;
  consecutiveNetworkFailures = 0;
  if (recovered) addTradeEvent('CONNECTION_RESTORED');

  writeStatus({
    running:robotRunningNow,
    updatedAt:new Date().toISOString(),
    connection:{ state:'online', lastOnlineAt, lastOfflineAt, error:null, consecutiveFailures:0 },
    env:config.env,
    autoTrade:config.autoTrade,
    symbol:config.symbol,
    productId:product.id,
    contractValue:product.contract_value,
    takerRate:product.taker_commission_rate,
    price:lastPrice,
    priceSource:config.priceSource,
    markPrice,
    lastTradedPrice,
    spotPrice,
    tickerTimestamp:ticker.timestamp,
    equity:cachedEquity,
    available:cachedAvailable,
    riskBase:'available',
    position:{size:cachedPositionSize, entryPrice:Number(cachedPosition?.entry_price||0)},
    pending,
    activeTrade,
    lossStreak,
    dailyBlocked:lossStreak >= config.maxDailyLosses,
    strategy:{
      emaLen:config.emaLen,
      slopeLookback:config.slopeLookback,
      rr:config.rr,
      riskPct:config.riskPct,
      minStopPct:config.minStopPct,
      maxEffectiveLeverage:config.maxEffectiveLeverage,
      maxFeeRiskPct:config.maxFeeRiskPct,
      maxDailyLosses:config.maxDailyLosses,
      priceSource:config.priceSource,
      resolution:config.resolution,
      resolutionSec:config.resolutionSec,
      candleSource:'traded_price',
      candleHistoryBars:config.candleHistoryBars
    },
    polling:{
      tickerMs:config.pollMs,
      positionMs:POSITION_REFRESH_MS,
      walletMs:WALLET_REFRESH_MS,
      candles:`new completed ${config.resolution} candle`,
      lastPositionFetchAt:lastPositionFetchAt ? new Date(lastPositionFetchAt).toISOString() : null,
      lastWalletFetchAt:lastWalletFetchAt ? new Date(lastWalletFetchAt).toISOString() : null,
      lastCandleFetchAt:lastCandleFetchAt ? new Date(lastCandleFetchAt).toISOString() : null
    },
    decision,
    currentStatus: !robotRunningNow
      ? cachedPositionSize !== 0
        ? { action:'STOPPED', reason:'POSITION_STILL_OPEN', source:activeTrade?.source || 'exchange', at:new Date().toISOString() }
        : { action:'STOPPED', reason:'ROBOT_STOPPED', at:new Date().toISOString() }
      : cachedPositionSize !== 0
        ? activeTrade?.source === 'exchange_existing'
          ? { action:'ACTIVE', reason:'EXISTING_POSITION', source:'exchange_existing', at:new Date().toISOString() }
          : { action:'ENTRY', reason:'ALGO_POSITION_OPEN', source:activeTrade?.source || 'bot', at:new Date().toISOString() }
        : { action:decision.action, reason:decision.reason || (pending ? 'WAITING_FOR_BREAKOUT' : 'NO_VALID_SETUP'), at:new Date().toISOString() },
    tradeEvents,
    logs:uiLogs
  });
}

async function main() {
  while (true) {
    try {
      await cycle();
    } catch (e:any) {
      const message = e?.message || String(e);
      const wasOnline = connectionState === 'online';
      connectionState = 'offline';
      connectionError = message;
      consecutiveNetworkFailures += 1;
      if (wasOnline) {
        lastOfflineAt = new Date().toISOString();
        addTradeEvent('CONNECTION_LOST', { error:message });
      }
      // Keep the worker alive. The next loop automatically retries Delta; when
      // connectivity returns a normal successful cycle restores ONLINE state.
      writeStatus({
        running:readControl().running,
        updatedAt:new Date().toISOString(),
        env:config.env,
        symbol:config.symbol,
        autoTrade:config.autoTrade,
        connection:{ state:'offline', lastOnlineAt, lastOfflineAt, error:connectionError, consecutiveFailures:consecutiveNetworkFailures },
        error:message,
        tradeEvents,
        logs:uiLogs
      });
    }
    await sleep(config.pollMs);
  }
}

main();
