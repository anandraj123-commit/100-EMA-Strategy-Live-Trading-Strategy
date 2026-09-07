import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import React from 'react';
import DecisionLogRow from '../components/DecisionLogRow';
import {decisionLogPresentation} from '../lib/decision-log';
import type {Candle} from '../lib/strategy';
import {workerHarness} from './strategy-regression/worker-harness';

const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:React.ReactElement)=>string};
const display=(log:any)=>renderToStaticMarkup(React.createElement(DecisionLogRow,{log,priceSource:'last'}))
  .replace(/<[^>]*>/g,' ').replaceAll('&gt;','>').replaceAll('&lt;','<').replace(/\s+/g,' ');
const row=(worker:ReturnType<typeof workerHarness>,time:number)=>JSON.parse(JSON.stringify(worker.inspect().uiLogs.find((log:any)=>log.candleTime===time)));
const T0=1200,R=300;
const observed=(index:number)=>T0+(index+1)*R+2;
const neutral=(index:number):Candle=>({time:T0+index*R,open:100,high:100,low:100,close:100});
function candles(direction:'long'|'short'):Candle[]{
  const closes=direction==='long'?[90,92,94,96]:[110,108,106,104];
  return [...closes.map((close,i)=>({time:i*R,open:close,high:close+1,low:close-1,close})),
    direction==='long'?{time:T0,open:97,high:101,low:96,close:100}:{time:T0,open:103,high:104,low:99,close:100}];
}

for(const direction of ['long','short'] as const){
  const trigger=direction==='long'?101:99,sl=direction==='long'?96:104;
  test(`${direction} T0 logs SIGNAL CREATED and NOT ELIGIBLE, never breakout NO`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,direction==='long'?102:98);
    const log=row(worker,T0),text=display(log);
    assert.equal(log.strategyLifecycle.lifecycleStage,'SIGNAL_CREATED');
    assert.equal(log.strategyLifecycle.signalCandleTime,T0);
    assert.equal(log.strategyLifecycle.breakoutEligible,false);
    assert.equal(log.strategyLifecycle.breakoutEvaluated,false);
    assert.equal(log.strategyLifecycle.eligibleCandlesRemaining,2);
    assert.equal(log.strategyLifecycle.eligibleCandleNumber,0);
    assert.match(text,/Current eligible candle: 0 \/ 2/);
    assert.match(text,/WAIT · SIGNAL CREATED/);
    assert.match(text,/Breakout: NOT ELIGIBLE ON SIGNAL CANDLE/);
    assert.doesNotMatch(text,/Breakout: NO(?:\s|$)/);
    assert.match(text,/Next eligible candle: 1 \/ 2/);
    await worker.cycle(observed(0)+1,history,trigger);
    assert.match(display(row(worker,T0)),/SIGNAL CANDLE · ENTRY NOT ELIGIBLE/);
  });

  test(`${direction} T1/T2 log eligible count, remaining candles, and original owner/trigger/SL`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    for(const index of [1,2]){
      history.push(neutral(index));
      await worker.cycle(observed(index),history,direction==='long'?100:100);
      const log=row(worker,T0+index*R),lifecycle=log.strategyLifecycle,text=display(log);
      assert.equal(lifecycle.signalCandleTime,T0);
      assert.equal(lifecycle.pendingDirection,direction);
      assert.equal(lifecycle.trigger,trigger);
      assert.equal(lifecycle.sl,sl);
      assert.equal(lifecycle.breakoutEligible,true);
      assert.equal(lifecycle.eligibleCandleNumber,index);
      assert.equal(lifecycle.eligibleCandlesRemaining,2-index);
      assert.equal(lifecycle.lifecycleStage,'BREAKOUT_NOT_REACHED');
      assert.ok(text.includes(`Current eligible candle: ${index} / 2`));
      assert.ok(text.includes(`Stored trigger ${trigger} | Original signal SL ${sl}`));
      assert.ok(text.includes(index===1?'WAIT · WAITING FOR BREAKOUT':'WAIT · LAST BREAKOUT CANDLE'));
    }
  });

  test(`${direction} T3 preserves old expiry details instead of WAITING FOR BREAKOUT`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    history.push(neutral(1),neutral(2),neutral(3));
    await worker.cycle(observed(3),history,direction==='long'?102:98);
    const log=row(worker,T0+3*R),lifecycle=log.strategyLifecycle,text=display(log);
    assert.equal(lifecycle.pendingExpired,true);
    assert.equal(lifecycle.previousPending.candleTime,T0);
    assert.equal(lifecycle.previousPending.trigger,trigger);
    assert.equal(lifecycle.previousPending.sl,sl);
    assert.equal(lifecycle.eligibleCandlesUsed,2);
    assert.equal(lifecycle.pendingExists,false);
    assert.match(text,/EXPIRED · NO BREAKOUT/);
    assert.match(text,/Breakout: NOT ELIGIBLE · SETUP EXPIRED/);
    assert.match(text,/Eligible candles used: 2 \/ 2/);
    assert.doesNotMatch(text,/WAITING FOR BREAKOUT/);
    await worker.cycle(observed(3)+1,history,trigger);
    assert.match(display(row(worker,T0+3*R)),/EXPIRED · NO BREAKOUT/);
  });

  test(`${direction} T3 displays old expiry and new SHORT signal together`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    const newSignal:Candle={time:T0+3*R,open:100,high:105,low:85,close:90};
    history.push(neutral(1),neutral(2),newSignal);
    await worker.cycle(observed(3),history,84);
    const log=row(worker,newSignal.time),lifecycle=log.strategyLifecycle,text=display(log);
    assert.equal(lifecycle.previousPending.candleTime,T0);
    assert.equal(lifecycle.previousPending.direction,direction);
    assert.equal(lifecycle.pendingExpired,true);
    assert.equal(lifecycle.signalCandleTime,newSignal.time);
    assert.equal(lifecycle.currentSignal.action,'CREATED');
    assert.equal(lifecycle.trigger,85);
    assert.equal(lifecycle.sl,105);
    assert.equal(lifecycle.breakoutEligible,false);
    assert.match(text,/NEW SETUP · PREVIOUS SETUP EXPIRED/);
    assert.match(text,/Current candle signal: SELL \(SHORT\)/);
    assert.match(text,/Breakout: NOT ELIGIBLE ON SIGNAL CANDLE/);
    assert.match(text,/Eligible candles available: 2/);
  });

  test(`${direction} active pending plus opposite signal displays ignored signal separately`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    history.push({time:T0+R,open:100,high:200,low:10,close:direction==='long'?90:110});
    await worker.cycle(observed(1),history,trigger);
    const log=row(worker,T0+R),lifecycle=log.strategyLifecycle,text=display(log);
    assert.equal(lifecycle.currentSignal.action,'IGNORED_EXISTING_PENDING');
    assert.equal(lifecycle.currentSignal.direction,direction==='long'?'short':'long');
    assert.equal(lifecycle.pendingDirection,direction);
    assert.equal(lifecycle.signalCandleTime,T0);
    assert.equal(lifecycle.trigger,trigger);
    assert.equal(lifecycle.sl,sl);
    assert.match(text,/WAIT · EXISTING PENDING RETAINED/);
    assert.match(text,/IGNORED — EXISTING PENDING ACTIVE/);
    assert.match(text,/Current eligible candle: 1 \/ 2/);
  });

  test(`${direction} breakout equality is displayed as NO, with strict comparison`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    history.push(neutral(1));
    await worker.cycle(observed(1),history,trigger);
    const log=row(worker,T0+R),text=display(log);
    assert.equal(log.strategyLifecycle.breakoutPassed,false);
    assert.match(text,/Breakout: NO · PRICE EQUAL TO TRIGGER/);
    assert.ok(text.includes(`Required: price ${direction==='long'?'>':'<'} trigger`));
  });

  test(`${direction} successful breakout preserves entry milestones and displays the active position`,async()=>{
    const worker=workerHarness(),history=candles(direction);
    await worker.cycle(observed(0),history,trigger);
    history.push(neutral(1));
    await worker.cycle(observed(1),history,direction==='long'?102:98);
    const log=row(worker,T0+R),text=display(log);
    assert.equal(log.strategyLifecycle.lifecycleStage,'BREAKOUT_TRIGGERED');
    assert.match(text,/TRADE ACTIVE · PROTECTION ACTIVE/);
    assert.match(text,/Breakout: NOT ELIGIBLE · POSITION OPEN/);
    assert.match(text,/Entry history: BREAKOUT CONFIRMED/);
    for(const stage of ['ENTRY_PREPARING','ENTRY_SUBMITTING','ENTRY_SUBMITTED','POSITION_OPEN','PROTECTION_ACTIVE'])
      assert.ok(log.entryProgress.some((event:any)=>event.stage===stage));
    assert.equal(log.strategyLifecycle.eligibleCandleNumber,1);
    assert.match(text,/Pending: NONE/);
    assert.match(text,/New Entry Allowed: NO/);
  });
}

test('completed OHLC and later live breakout price have separate labels and observation time',async()=>{
  const worker=workerHarness(),history=candles('long');
  await worker.cycle(observed(0),history,101);
  history.push(neutral(1));
  await worker.cycle(observed(1),history,101);
  await worker.cycle(observed(1)+1,history,100.5);
  const log=row(worker,T0+R),text=display(log);
  assert.equal(log.candle.close,100);
  assert.equal(log.price.last,101);
  assert.equal(log.strategyLifecycle.breakoutPrice,100.5);
  assert.equal(log.strategyLifecycle.breakoutPriceObservedAt,new Date((observed(1)+1)*1000).toISOString());
  assert.match(text,/Completed Candle OHLC: 100 \/ 100 \/ 100 \/ 100/);
  assert.match(text,/Live Breakout Price: 100.5/);
  assert.match(text,/Ticker snapshot last 101/);
  assert.match(text,/Configured price source: last/);
  assert.match(text,/Observed at:/);
});

test('no setup retains OHLC, EMA and all pattern diagnostics',async()=>{
  const worker=workerHarness(),history=candles('long').slice(0,4);
  history.push(neutral(0));
  await worker.cycle(observed(0),history,100);
  const text=display(row(worker,T0));
  assert.match(text,/WAIT · NO VALID SETUP/);
  for(const label of ['Completed Candle OHLC:','EMA:','bars ago:','BUY: slope','SELL: slope'])assert.ok(text.includes(label));
});

test('guard rejection overrides preliminary breakout approval in the displayed decision',async()=>{
  const worker=workerHarness(),history=candles('long');
  worker.config.minStopPct=100;
  await worker.cycle(observed(0),history,101);
  history.push(neutral(1));
  await worker.cycle(observed(1),history,102);
  const text=display(row(worker,T0+R));
  assert.match(text,/SKIP · STOP TOO TIGHT/);
  assert.match(text,/Breakout: YES/);
  assert.doesNotMatch(text,/ENTRY · BREAKOUT/);
});

test('candle eligibility does not claim a breakout evaluation when execution is blocked',()=>{
  const log={decision:{action:'WAIT',reason:'WAITING_FOR_BREAKOUT'},observationBlockReason:'ENTRY_INTENT_BLOCKED',strategyLifecycle:{
    pendingExists:true,breakoutEligible:true,breakoutEvaluated:false,breakoutPassed:null,lifecycleStage:'BREAKOUT_ELIGIBLE',eligibleCandlesRemaining:1
  }};
  assert.equal(decisionLogPresentation(log).title,'WAIT · ENTRY INTENT BLOCKED');
  assert.equal(decisionLogPresentation(log).breakout,'NOT EVALUATED · EXECUTION GATE BLOCKED');
});

test('old rows without lifecycle fields retain historical breakout interpretation',()=>{
  const log={candleTime:T0,candle:{open:100,high:101,low:99,close:100},decision:{action:'WAIT',reason:'WAITING_FOR_BREAKOUT'},
    setup:{direction:'long',trigger:101,sl:99},breakout:{passed:false,currentPrice:101,trigger:101}};
  const text=display(log);
  assert.match(text,/WAIT · WAITING FOR BREAKOUT/);
  assert.match(text,/Breakout: NO/);
  assert.doesNotMatch(text,/NOT ELIGIBLE|PRICE EQUAL TO TRIGGER/);
});

for(const direction of ['long','short'] as const)test(`${direction} pending retains its owner when another same-direction signal forms`,async()=>{
  const worker=workerHarness(),history=candles(direction),trigger=direction==='long'?101:99;
  await worker.cycle(observed(0),history,trigger);
  history.push({time:T0+R,open:100,high:200,low:10,close:direction==='long'?110:90});
  await worker.cycle(observed(1),history,trigger);
  const log=row(worker,T0+R),text=display(log);
  assert.equal(log.strategyLifecycle.currentSignal.direction,direction);
  assert.equal(log.strategyLifecycle.signalCandleTime,T0);
  assert.equal(log.strategyLifecycle.trigger,trigger);
  assert.match(text,/EXISTING PENDING RETAINED/);
  assert.match(text,/IGNORED — EXISTING PENDING ACTIVE/);
});

for(const size of [2,-2])for(const signal of ['long','short'] as const)
  test(`open position ${size} displays ${signal} analysis as ignored and never executable`,async()=>{
    const worker=workerHarness();worker.existingPosition(size);
    await worker.cycle(observed(0),candles(signal),signal==='long'?102:98);
    const log=row(worker,T0),text=display(log);
    assert.equal(log.runtimeObservation.positionOpen,true);
    assert.equal(log.runtimeObservation.newEntryAllowed,false);
    assert.match(decisionLogPresentation(log).title,/^TRADE ACTIVE · POSITION OPEN/);
    assert.ok(text.includes(`Current candle signal: ${signal==='long'?'BUY':'SELL'}`));
    assert.match(text,/IGNORED — POSITION ALREADY OPEN/);
    assert.match(text,/Pending: NONE/);
    assert.match(text,/Breakout eligible \(candle\): NO/);
    assert.match(text,/New Entry Allowed: NO/);
    assert.match(text,/Current P\/L:/);
    assert.doesNotMatch(text,/WAITING FOR BREAKOUT|NEW PENDING CREATED|Pending: ACTIVE/);
  });

test('closure is displayed with known evidence, then waits for a new signal without replaying open-trade analysis',async()=>{
  const worker=workerHarness();worker.existingPosition(-2);
  const history=candles('long');
  await worker.cycle(observed(0),history,102);
  worker.setPosition(0);history.push(neutral(1));
  await worker.cycle(observed(1),history,102);
  let log=row(worker,T0+R),text=display(log);
  assert.equal(decisionLogPresentation(log).title,'TRADE CLOSED');
  assert.match(text,/Exit Reason: UNKNOWN/);
  assert.match(text,/Exit: —/);
  assert.match(text,/Position: NONE/);
  await worker.cycle(observed(1)+1,history,102);
  log=row(worker,T0+R);text=display(log);
  assert.equal(decisionLogPresentation(log).title,'WAIT · WAITING FOR NEW SIGNAL');
  assert.match(text,/Pending: NONE/);
  assert.match(text,/New Entry Allowed: YES · SUBJECT TO/);
  history.push(neutral(2));await worker.cycle(observed(2),history,102);
  assert.equal(row(worker,T0+2*R).strategyLifecycle.pendingExists,false);
  assert.match(display(row(worker,T0+2*R)),/WAITING FOR NEW SIGNAL/);
  assert.equal(worker.orders.length,0);
});

const runtimeFixture={positionOpen:false,newEntryAllowed:true,blockReason:null,robotRunning:true,autoTrade:true,
  stage:null,currentPrice:100,priceSource:'last',observedAt:'2026-09-08T00:00:00Z',position:null,exit:null};
const lifecycleFixture={pendingExists:true,breakoutEligible:true,breakoutEvaluated:true,breakoutPassed:true,
  lifecycleStage:'BREAKOUT_TRIGGERED',eligibleCandleNumber:1,entryValidCandles:2,eligibleCandlesRemaining:1,
  pendingDirection:'long',trigger:99,breakoutPrice:100};

test('breakout confirmation, preparation and submission have explicit display stages',()=>{
  const base={runtimeObservation:runtimeFixture,strategyLifecycle:lifecycleFixture,decision:{action:'ENTRY'}};
  assert.equal(decisionLogPresentation(base).title,'ENTRY · BREAKOUT CONFIRMED');
  for(const [entryStage,title] of [['ENTRY_PREPARING','ENTRY · PREPARING ORDER'],['ENTRY_SUBMITTING','ENTRY · SUBMITTING ORDER'],['ENTRY_SUBMITTED','ENTRY · ORDER SUBMITTED']]){
    assert.equal(decisionLogPresentation({...base,entryStage}).title,title);
    assert.doesNotMatch(display({...base,entryStage}),/WAITING FOR BREAKOUT/);
  }
});

test('closed trade shows provided accounting and exit reason without computing replacements',()=>{
  const log={candleTime:T0,strategyLifecycle:{...lifecycleFixture,pendingExists:false},runtimeObservation:{...runtimeFixture,stage:'TRADE_CLOSED',exit:{
    detectedAt:'2026-09-08T00:00:00Z',closedAt:'2026-09-07T23:59:59Z',exitReason:'TP',entry:100,exit:110,grossPnL:20,fees:1.18,netPnL:18.82,financialStatus:'actual'}}};
  const text=display(log);
  for(const label of ['TRADE CLOSED','Exit Reason: TP','Entry: 100','Exit: 110','Gross P/L: 20','Fees (including charges): 1.18','Net P/L: 18.82','Closed At: 2026-09-07T23:59:59Z'])assert.ok(text.includes(label));
});

test('protection reconciliation warning preserves reported protection instead of inventing missing protection',()=>{
  const log={candleTime:T0,strategyLifecycle:lifecycleFixture,runtimeObservation:{...runtimeFixture,positionOpen:true,newEntryAllowed:false,
    position:{direction:'long',size:2,entry:100,initialSL:90,currentSL:95,tp:120,contractValue:0.1,protectionState:'ACTIVE',exchangeSync:{status:'UNVERIFIABLE',sl:95,tp:120}}}};
  const text=display(log);
  assert.match(text,/Protection: ACTIVE \| Exchange reconciliation: UNVERIFIABLE/);
  assert.doesNotMatch(text,/REPAIR REQUIRED|PROTECTION MISSING/);
  assert.match(text,/Initial SL: 90 \| Current SL: 95/);
  assert.match(text,/Breakout: NOT ELIGIBLE · POSITION OPEN/);
});

test('stopped robot and AUTO_TRADE off show entry restrictions without changing pending semantics',async()=>{
  const stopped=workerHarness();stopped.stop();await stopped.cycle(observed(0),candles('long'),102);
  assert.equal(decisionLogPresentation(row(stopped,T0)).title,'ROBOT STOPPED');
  assert.match(display(row(stopped,T0)),/New Entry Allowed: NO/);
  const off=workerHarness();off.config.autoTrade=false;await off.cycle(observed(0),candles('long'),102);
  const log=row(off,T0),text=display(log);
  assert.equal(log.strategyLifecycle.pendingExists,true);
  assert.match(text,/Auto Trade: OFF/);
  assert.match(text,/New Entry Submission: DISABLED/);
  assert.match(text,/New Entry Allowed: NO/);
});

test('daily-loss and unavailable private state describe the execution block, not a missing signal',async()=>{
  const daily=workerHarness();daily.config.maxDailyLosses=0;
  await daily.cycle(observed(0),candles('long'),102);
  assert.equal(decisionLogPresentation(row(daily,T0)).title,'BLOCKED · DAILY LOSS LIMIT');
  assert.match(display(row(daily,T0)),/Current candle signal: BUY/);
  const privateState=workerHarness();privateState.config.apiKey='';
  await assert.rejects(privateState.cycle(observed(0),candles('long'),102));
  assert.equal(decisionLogPresentation(row(privateState,T0)).title,'BLOCKED · ACCOUNT STATE UNAVAILABLE');
  assert.match(display(row(privateState,T0)),/Current candle signal: BUY/);
});

test('a later poll cannot display preparation or a new pending after the setup was consumed',async()=>{
  const worker=workerHarness(),history=candles('long');worker.config.minStopPct=100;
  await worker.cycle(observed(0),history,101);
  history.push(neutral(1));await worker.cycle(observed(1),history,102);
  assert.match(display(row(worker,T0+R)),/SKIP · STOP TOO TIGHT/);
  await worker.cycle(observed(1)+1,history,102);
  const text=display(row(worker,T0+R));
  assert.match(text,/WAIT · SETUP ENDED/);
  assert.doesNotMatch(decisionLogPresentation(row(worker,T0+R)).title,/PREPARING|ENTRY|WAITING FOR BREAKOUT/);
});

test('expiry after a post-close setup still displays EXPIRED instead of masking it with post-exit waiting',async()=>{
  const worker=workerHarness();worker.existingPosition(-2);
  const history=candles('long');await worker.cycle(observed(0),history,101);
  worker.setPosition(0);history.push(neutral(1));await worker.cycle(observed(1),history,101);
  history.push({time:T0+2*R,open:100,high:105,low:85,close:90});
  await worker.cycle(observed(2),history,85);
  assert.match(display(row(worker,T0+2*R)),/WAIT · SIGNAL CREATED/);
  history.push(neutral(3),neutral(4),neutral(5));await worker.cycle(observed(5),history,85);
  const text=display(row(worker,T0+5*R));
  assert.match(text,/EXPIRED · NO BREAKOUT/);
  assert.match(text,/Pending: EXPIRED/);
});

test('same-candle closure retains the recorded open-position ignore reason without displaying replayed pending',async()=>{
  const worker=workerHarness();worker.existingPosition(-2);const history=candles('long');
  await worker.cycle(observed(0),history,102);
  worker.setPosition(0);await worker.cycle(observed(0)+8,history,102);
  await worker.cycle(observed(0)+9,history,102);
  const log=row(worker,T0),text=display(log);
  assert.equal(log.strategyLifecycle.ignoredSignalReason,'POSITION_OPEN');
  assert.match(text,/IGNORED — POSITION ALREADY OPEN/);
  assert.match(text,/WAIT · WAITING FOR NEW SIGNAL/);
  assert.match(text,/Pending: NONE/);
  assert.doesNotMatch(text,/NEW PENDING CREATED|Pending: ACTIVE/);
});
