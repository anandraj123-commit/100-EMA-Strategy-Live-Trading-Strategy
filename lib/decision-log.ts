// Presentation only. These fields describe worker observations and must never
// be used to authorize strategy transitions or orders.
export type LogSetup={direction:'long'|'short';candleTime:number;trigger:number;sl:number};
export type StrategyLifecycle={
  signalCandleTime:number|null;
  pendingDirection:'long'|'short'|null;
  trigger:number|null;
  sl:number|null;
  pendingExists:boolean;
  entryValidCandles:number;
  eligibleCandleNumber:number|null;
  eligibleCandlesRemaining:number;
  eligibleCandlesUsed:number;
  breakoutEligible:boolean;
  pendingExpired:boolean;
  lifecycleStage:'SIGNAL_CREATED'|'SIGNAL_DETECTED'|'WAITING_FOR_ELIGIBLE_CANDLE'|'BREAKOUT_ELIGIBLE'|'BREAKOUT_NOT_REACHED'|'BREAKOUT_TRIGGERED'|'PENDING_EXPIRED'|'NO_VALID_SETUP';
  previousPending:LogSetup|null;
  currentSignal:(LogSetup&{action:'CREATED'|'IGNORED_EXISTING_PENDING'|'NOT_ACTIVATED'})|null;
  ignoredSignalReason?:'POSITION_OPEN'|'PENDING_ACTIVE'|'PRECEDES_FLAT_CONFIRMATION'|null;
  breakoutEvaluated:boolean;
  breakoutPassed:boolean|null;
  breakoutPrice:number|null;
  breakoutPriceSource:string|null;
  breakoutPriceObservedAt:string|null;
};

export type DecisionLogRuntime={
  positionOpen:boolean;
  newEntryAllowed:boolean;
  blockReason:string|null;
  robotRunning:boolean;
  autoTrade:boolean;
  stage:'POSITION_OPEN'|'TRADE_CLOSED'|'WAITING_FOR_NEW_SIGNAL'|null;
  currentPrice:number;
  priceSource:string;
  observedAt:string;
  position:{direction:string;size:number|null;entry:number|null;trigger:number|null;
    initialSL:number|null;currentSL:number|null;tp:number|null;contractValue:number|null;
    protectionState:string;exchangeSync:any;protectionObservation?:{type:string;reason:string|null;at:string}|null}|null;
  exit:{detectedAt:string;exitReason?:string;entry?:number|null;exit?:number|null;
    grossPnL?:number|null;fees?:number|null;netPnL?:number|null;closedAt?:string|null;financialStatus?:string}|null;
};
export type DecisionLogEntryStage='BREAKOUT_CONFIRMED'|'ENTRY_PREPARING'|'ENTRY_SUBMITTING'|'ENTRY_SUBMITTED'|'POSITION_OPEN'|'PROTECTION_PENDING'|'PROTECTION_ACTIVE'|'PROTECTION_REPAIR_REQUIRED';

export function decisionLogPresentation(log:any){
  const lifecycle=log.strategyLifecycle as StrategyLifecycle|undefined;
  const runtime=log.runtimeObservation as DecisionLogRuntime|undefined;
  const execution=log.executionDecision;
  const decision=execution&&execution.reason&&execution.reason!=='WAITING_FOR_BREAKOUT'&&execution.reason!=='NO_VALID_SETUP'
    ? execution : log.decision;
  let title=`${decision?.action||'WAIT'} · ${(decision?.reason||'NO_VALID_SETUP').replaceAll('_',' ')}`;
  let tone=decision?.action==='ENTRY'?'ok':decision?.action==='SKIP'?'bad':'wait';
  if(!lifecycle)return {title,tone,breakout:null}; // Old snapshots retain their legacy meaning.

  const blocked=runtime?.blockReason||log.observationBlockReason||
    (decision?.reason&&!['WAITING_FOR_BREAKOUT','NO_VALID_SETUP','TRADE_APPROVED','ORDER_SENT','ALGO_POSITION_OPEN'].includes(decision.reason)?decision.reason:null);
  if(runtime?.positionOpen){
    title=runtime.position?.protectionState==='ACTIVE'&&runtime.position?.exchangeSync?.status!=='UNVERIFIABLE'
      ?'TRADE ACTIVE · PROTECTION ACTIVE · POSITION OPEN NEW ENTRY BLOCKED'
      :'TRADE ACTIVE · POSITION OPEN NEW ENTRY BLOCKED';tone='ok';
  }else if(runtime?.stage==='TRADE_CLOSED'){
    title='TRADE CLOSED';tone='wait';
  }else if(runtime&&!runtime.robotRunning){
    title='ROBOT STOPPED';tone='wait';
  }else if(blocked==='PRIVATE_ACCOUNT_UNAVAILABLE'){
    title='BLOCKED · ACCOUNT STATE UNAVAILABLE';tone='bad';
  }else if(blocked==='DAILY_LOSS_LIMIT'){
    title='BLOCKED · DAILY LOSS LIMIT';tone='bad';
  }else if(blocked==='AUTO_TRADE_OFF'){
    title='AUTO TRADE OFF · NEW ENTRY SUBMISSION DISABLED';tone='wait';
  }else if(runtime?.stage==='WAITING_FOR_NEW_SIGNAL'&&!blocked){
    title='WAIT · WAITING FOR NEW SIGNAL';tone='wait';
  }else if(log.order?.market==='SENT'&&!runtime){
    title='ENTRY · BREAKOUT · ORDER SENT';tone='ok';
  }else if(blocked){
    title=`${decision?.action==='STOPPED'?'STOPPED':decision?.action==='SKIP'?'SKIP':'WAIT'} · ${String(blocked).replaceAll('_',' ')}`;
    tone=decision?.action==='SKIP'?'bad':'wait';
  }else if(log.entryStage==='ENTRY_SUBMITTED'){
    title='ENTRY · ORDER SUBMITTED';tone='ok';
  }else if(log.entryStage==='ENTRY_SUBMITTING'){
    title='ENTRY · SUBMITTING ORDER';tone='wait';
  }else if(log.entryStage==='ENTRY_PREPARING'){
    title='ENTRY · PREPARING ORDER';tone='wait';
  }else if(!lifecycle.pendingExists&&(lifecycle.currentSignal?.action==='CREATED'||lifecycle.breakoutPassed)){
    title='WAIT · SETUP ENDED';tone='wait';
  }else if(lifecycle.currentSignal?.action==='CREATED'){
    title=lifecycle.previousPending?'NEW SETUP · PREVIOUS SETUP EXPIRED':'WAIT · SIGNAL CREATED';tone='wait';
  }else if(lifecycle.lifecycleStage==='PENDING_EXPIRED'){
    title='EXPIRED · NO BREAKOUT';tone='wait';
  }else if(lifecycle.breakoutPassed){
    title='ENTRY · BREAKOUT CONFIRMED';tone='wait';
  }else if(lifecycle.currentSignal?.action==='IGNORED_EXISTING_PENDING'){
    title='WAIT · EXISTING PENDING RETAINED';tone='wait';
  }else if(lifecycle.breakoutEligible){
    title=lifecycle.eligibleCandlesRemaining===0?'WAIT · LAST BREAKOUT CANDLE':'WAIT · WAITING FOR BREAKOUT';tone='wait';
  }else if(lifecycle.lifecycleStage==='SIGNAL_DETECTED'){
    title='WAIT · SIGNAL DETECTED · PENDING NOT CREATED';tone='wait';
  }else if(lifecycle.pendingExists){
    title='WAIT · WAITING FOR ELIGIBLE CANDLE';tone='wait';
  }

  let breakout:string;
  if(runtime?.positionOpen)breakout='NOT ELIGIBLE · POSITION OPEN';
  else if(runtime?.stage==='TRADE_CLOSED'||runtime?.stage==='WAITING_FOR_NEW_SIGNAL')breakout='NOT ELIGIBLE · WAITING FOR NEW SIGNAL';
  else if(lifecycle.lifecycleStage==='PENDING_EXPIRED')breakout='NOT ELIGIBLE · SETUP EXPIRED';
  else if(!lifecycle.pendingExists&&!lifecycle.breakoutEvaluated)breakout='NOT ELIGIBLE · NO ACTIVE PENDING';
  else if(!lifecycle.breakoutEligible)breakout='NOT ELIGIBLE ON SIGNAL CANDLE';
  else if(!lifecycle.breakoutEvaluated)breakout='NOT EVALUATED · EXECUTION GATE BLOCKED';
  else if(lifecycle.breakoutPassed)breakout='YES';
  else if(lifecycle.breakoutPrice===lifecycle.trigger)breakout='NO · PRICE EQUAL TO TRIGGER';
  else breakout='NO';
  return {title,tone,breakout};
}
