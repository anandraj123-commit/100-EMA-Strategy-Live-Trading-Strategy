import React from 'react';
import {decisionLogPresentation,type StrategyLifecycle,type DecisionLogRuntime} from '../lib/decision-log';

import {calculateCurrentPnL} from '../lib/dashboard';

const candleTime=(time:number|null)=>time==null?'—':new Date(time*1000).toLocaleString();
const stageLabels:Record<StrategyLifecycle['lifecycleStage'],string>={
  SIGNAL_CREATED:'SIGNAL CANDLE · ENTRY NOT ELIGIBLE',
  SIGNAL_DETECTED:'SIGNAL DETECTED · PENDING NOT CREATED',
  WAITING_FOR_ELIGIBLE_CANDLE:'WAITING FOR ELIGIBLE CANDLE',
  BREAKOUT_ELIGIBLE:'BREAKOUT ELIGIBLE',
  BREAKOUT_NOT_REACHED:'BREAKOUT NOT REACHED',
  BREAKOUT_TRIGGERED:'BREAKOUT TRIGGERED',
  PENDING_EXPIRED:'PENDING EXPIRED',
  NO_VALID_SETUP:'NO VALID SETUP'
};

export default function DecisionLogRow({log,priceSource}:{log:any;priceSource?:string}){
  const lifecycle=log.strategyLifecycle as StrategyLifecycle|undefined;
  const presentation=decisionLogPresentation(log);
  const runtime=log.runtimeObservation as DecisionLogRuntime|undefined;
  const position=runtime?.position;
  const flatAfterExit=runtime?.stage==='TRADE_CLOSED'||runtime?.stage==='WAITING_FOR_NEW_SIGNAL';
  const pendingExecutable=!runtime?.positionOpen&&!flatAfterExit&&lifecycle?.pendingExists;
  const pnl=position?calculateCurrentPnL({positionSize:position.size,entryPrice:position.entry,currentPrice:runtime?.currentPrice,contractValue:position.contractValue}):null;
  return <li>
    <div className="logHead">
      <strong>Completed candle (open): {candleTime(log.candleTime)}</strong>
      <span className={presentation.tone}>{presentation.title}</span>
    </div>
    <div className="logGrid">
      <span>Completed Candle OHLC: {log.candle?.open} / {log.candle?.high} / {log.candle?.low} / {log.candle?.close}</span>
      <span>EMA: {log.ema?.current ?? '—'} | {log.ema?.lookback} bars ago: {log.ema?.previous ?? '—'} | {log.ema?.direction ?? '—'}</span>
      <span>Candle feed: {log.price?.candleSource ?? 'traded_price'} | Configured price source: {log.price?.source ?? priceSource ?? 'last'} | Ticker snapshot last {log.price?.last ?? '—'} | mark {log.price?.mark ?? '—'}</span>
      <span>BUY: slope {log.buy?.slope ? 'PASS' : 'FAIL'}, A {log.buy?.patternA ? 'YES' : 'NO'}, B {log.buy?.patternB ? 'YES' : 'NO'}, setup {log.buy?.setup ? 'YES' : 'NO'}</span>
      <span>SELL: slope {log.sell?.slope ? 'PASS' : 'FAIL'}, A {log.sell?.patternA ? 'YES' : 'NO'}, B {log.sell?.patternB ? 'YES' : 'NO'}, setup {log.sell?.setup ? 'YES' : 'NO'}</span>
      {lifecycle ? <>
        {lifecycle.previousPending&&<span>Previous setup: {lifecycle.previousPending.direction.toUpperCase()} from {candleTime(lifecycle.previousPending.candleTime)} · EXPIRED | Trigger {lifecycle.previousPending.trigger} | SL {lifecycle.previousPending.sl}</span>}
        {lifecycle.currentSignal&&<span>Current candle signal: {lifecycle.currentSignal.direction==='long'?'BUY':'SELL'} ({lifecycle.currentSignal.direction.toUpperCase()}) | Signal candle {candleTime(lifecycle.currentSignal.candleTime)} | Trigger {lifecycle.currentSignal.trigger} | SL {lifecycle.currentSignal.sl} | {runtime?.positionOpen||lifecycle.ignoredSignalReason==='POSITION_OPEN'?'IGNORED — POSITION ALREADY OPEN':flatAfterExit?'IGNORED — WAITING FOR NEW SIGNAL':lifecycle.currentSignal.action==='CREATED'?(lifecycle.pendingExists?'NEW PENDING CREATED':'PENDING ENDED'):lifecycle.currentSignal.action==='IGNORED_EXISTING_PENDING'?'IGNORED — EXISTING PENDING ACTIVE':'PENDING NOT CREATED'}</span>}
        <span>Pending: {runtime?.positionOpen||flatAfterExit?'NONE':lifecycle.pendingExists?'ACTIVE':lifecycle.lifecycleStage==='PENDING_EXPIRED'?'EXPIRED':lifecycle.breakoutEvaluated?'ENDED':'NONE'}{!runtime?.positionOpen&&!flatAfterExit&&lifecycle.pendingDirection ? ` · ${lifecycle.pendingDirection.toUpperCase()}` : ''}</span>
        {!runtime?.positionOpen&&!flatAfterExit&&lifecycle.signalCandleTime!=null&&<span>Pending signal candle: {candleTime(lifecycle.signalCandleTime)} | Stored trigger {lifecycle.trigger} | Original signal SL {lifecycle.sl}</span>}
        <span>Lifecycle: {runtime?.positionOpen?'POSITION OPEN':flatAfterExit?runtime?.stage?.replaceAll('_',' '):lifecycle.currentSignal?.action==='IGNORED_EXISTING_PENDING'?'EXISTING PENDING RETAINED':stageLabels[lifecycle.lifecycleStage]}</span>
        <span>Entry valid candles: {lifecycle.entryValidCandles} | Breakout eligible (candle): {!runtime?.positionOpen&&!flatAfterExit&&lifecycle.breakoutEligible?'YES':'NO'}</span>
        {!runtime?.positionOpen&&!flatAfterExit&&lifecycle.eligibleCandleNumber!=null&&<span>Current eligible candle: {lifecycle.eligibleCandleNumber} / {lifecycle.entryValidCandles}</span>}
        {pendingExecutable&&lifecycle.lifecycleStage==='SIGNAL_CREATED'&&<span>Next eligible candle: 1 / {lifecycle.entryValidCandles} | Eligible candles available: {lifecycle.eligibleCandlesRemaining}</span>}
        {!runtime?.positionOpen&&!flatAfterExit&&lifecycle.breakoutEligible&&<span>Eligible candles remaining after this candle: {lifecycle.eligibleCandlesRemaining}</span>}
        {lifecycle.lifecycleStage==='PENDING_EXPIRED'&&<span>Eligible candles used: {lifecycle.eligibleCandlesUsed} / {lifecycle.entryValidCandles}</span>}
        <span>Breakout: {presentation.breakout}</span>
        {!runtime?.positionOpen&&!flatAfterExit&&lifecycle.breakoutEvaluated&&<span>Live Breakout Price: {lifecycle.breakoutPrice} | Trigger {lifecycle.trigger} | Required: price {lifecycle.pendingDirection==='long'?'>':'<'} trigger | Configured price source: {lifecycle.breakoutPriceSource??'—'} (existing fallback applies) | Observed at: {lifecycle.breakoutPriceObservedAt?new Date(lifecycle.breakoutPriceObservedAt).toLocaleString():'—'}</span>}
      </> : <>
        {log.setup&&<span>Setup: {log.setup.direction.toUpperCase()} | Trigger {log.setup.trigger} | SL {log.setup.sl}</span>}
        {log.breakout&&<span>Breakout: {log.breakout.passed?'YES':'NO'} | Live Breakout Price: {log.breakout.currentPrice} | Trigger {log.breakout.trigger}</span>}
      </>}
      {runtime&&<>
        <span>Auto Trade: {runtime.autoTrade?'ON':'OFF'} | New Entry Submission: {runtime.autoTrade?'SUBJECT TO EXECUTION GUARDS':'DISABLED'} | Robot: {runtime.robotRunning?'RUNNING':'STOPPED'}</span>
        <span>New Entry Allowed: {runtime.newEntryAllowed?'YES · SUBJECT TO A VALID SETUP AND FINAL EXECUTION GUARDS':'NO'} | Strategy Entry State: {runtime.positionOpen?'BLOCKED — POSITION ALREADY OPEN':runtime.blockReason?.replaceAll('_',' ')??'WAITING FOR VALID SIGNAL / BREAKOUT'}</span>
        <span>Latest Live Price: {runtime.currentPrice} | Price Source: {runtime.priceSource} | Observed at: {new Date(runtime.observedAt).toLocaleString()}</span>
        {!runtime.positionOpen&&<span>Position: NONE</span>}
        {position&&<>
          <span>Position: {position.direction.toUpperCase()} | Position Size: {position.size==null?'—':Math.abs(position.size)} | Signed size: {position.size??'—'} contracts | Entry: {position.entry??'—'} | Signal Trigger: {position.trigger??'—'}</span>
          <span>Initial SL: {position.initialSL??'—'} | Current SL: {position.currentSL??'—'} | TP: {position.tp??'—'} | Current P/L: {pnl?.value==null?'—':pnl.value.toFixed(4)}</span>
          <span>Protection: {position.protectionState.replaceAll('_',' ')} | Exchange reconciliation: {position.exchangeSync?.status??'UNKNOWN'}</span>
          {position.protectionState==='ACTIVE'&&<span>SL Status: ACTIVE | TP Status: ACTIVE</span>}
          {position.protectionObservation&&<span>Protection observation: {position.protectionObservation.type.replaceAll('_',' ')} | {position.protectionObservation.reason??'—'} | At: {position.protectionObservation.at}</span>}
          {position.exchangeSync&&<span>Exchange SL: {position.exchangeSync.sl??'—'} | Exchange TP: {position.exchangeSync.tp??'—'}</span>}
        </>}
        {runtime.exit&&<span>Previous trade closed | Exit Reason: {runtime.exit.exitReason??'UNKNOWN'} | Entry: {runtime.exit.entry??'—'} | Exit: {runtime.exit.exit??'—'} | Gross P/L: {runtime.exit.grossPnL??'—'} | Fees (including charges): {runtime.exit.fees??'—'} | Net P/L: {runtime.exit.netPnL??'—'} | Closed At: {runtime.exit.closedAt??'UNKNOWN'} | Flat detected at: {runtime.exit.detectedAt} | Accounting: {runtime.exit.financialStatus??'UNAVAILABLE'}</span>}
      </>}
      {log.entryProgress?.length>0&&<span>Entry history: {log.entryProgress.map((event:any)=>`${event.stage.replaceAll('_',' ')} (${new Date(event.at).toLocaleTimeString()})`).join(' → ')}</span>}
      {log.risk&&<span>Risk base (available margin): {log.risk.riskBase} | RR: {log.risk.rr} | SL: {log.risk.sl} | Estimated fees: {log.risk.estimatedFees} | Risk: ${Number(log.risk.riskAmount).toFixed(4)} | Contracts {log.risk.contracts} | TP {log.risk.tp} | Leverage {Number(log.risk.effectiveLeverage).toFixed(2)}x | Fee/Risk {Number(log.risk.feeRiskPct).toFixed(2)}%</span>}
      {log.order&&<span>Order: {log.order.side?.toUpperCase()} MARKET {log.order.market} | ID {log.order.orderId??'—'} | Bracket {log.order.bracket??'—'}</span>}
    </div>
  </li>;
}
