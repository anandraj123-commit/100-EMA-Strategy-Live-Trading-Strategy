import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { evaluateSetup,type Candle } from '../lib/strategy';

const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
const cycle=worker.slice(worker.indexOf('async function cycle()'),worker.indexOf('async function refreshRuntimeSettings'));
const privateFailure=cycle.indexOf('}catch(error){privateAccountError=error;}');
const candleRefresh=cycle.indexOf('refreshCandlesIfNeeded(nowSec)');
const setupEvaluation=cycle.indexOf('evaluateSetup(completedCandles');
const decisionLog=cycle.indexOf('upsertUiLog(latest.time');
const failClosed=cycle.indexOf('if(privateAccountError)throw privateAccountError');
const breakout=cycle.indexOf("const breakout = pending.direction");
const marketOrder=cycle.indexOf('placeMarketOrder(');

test('private Delta auth failure still reaches public completed-candle and EMA/signal observation',()=>{
  assert.ok(privateFailure>=0);
  assert.ok(candleRefresh>privateFailure);
  assert.ok(setupEvaluation>candleRefresh);
  assert.ok(decisionLog>setupEvaluation);
  assert.ok(failClosed>decisionLog);

  const candle=(time:number,open:number,high:number,low:number,close:number):Candle=>({time,open,high,low,close});
  const rising=[candle(1,90,91,89,90),candle(2,92,93,91,92),candle(3,94,95,93,94),candle(4,96,97,95,96)];
  const signal=evaluateSetup([...rising,candle(5,97,101,96,100)],2,1);
  assert.deepEqual(signal&&{direction:signal.direction,trigger:signal.trigger,sl:signal.sl},{direction:'long',trigger:101,sl:96});
});

test('private failure cannot create pending from stale account state or reach entry execution',()=>{
  const pendingCreation=cycle.indexOf("if (s) pending = {...s");
  assert.ok(cycle.lastIndexOf('if (!privateAccountError',pendingCreation)>=0);
  assert.ok(failClosed>pendingCreation);
  assert.ok(breakout>failClosed);
  assert.ok(marketOrder>failClosed);
});

test('auth recovery resumes normal reconciliation without replaying the outage candle',()=>{
  assert.match(cycle,/let privateAccountError:unknown=null;/);
  assert.match(cycle,/try\{[\s\S]*?reconcileEntryIntents\(\)[\s\S]*?refreshPosition\(lastPrice\)[\s\S]*?refreshWallet\(\)/);
  assert.match(cycle,/evaluateSetup\(completedCandles[\s\S]*?lastSetupCandle = latest\.time/);
  assert.match(cycle,/candlesChanged && latest && latest\.time !== lastSetupCandle/);
});

test('robot, AUTO_TRADE, pending expiry, and final pre-order barriers remain intact',()=>{
  assert.match(cycle,/if \(!tradingEnabled\) \{\s*pending = null;/);
  assert.match(cycle,/pendingSetupExpired\(pending,latest\.time,config\.entryValidCandles,config\.resolutionSec\)/);
  assert.match(cycle,/else if \(!reject && config\.autoTrade\)/);
  assert.match(cycle,/finalPreOrderSafetyCheck/);
  assert.ok(cycle.indexOf('pendingSetupExpired(pending,latest.time')<breakout);
});
