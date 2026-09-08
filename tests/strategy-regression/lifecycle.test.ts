import assert from 'node:assert/strict';
import test from 'node:test';
import {pendingEntryEligible,pendingSetupExpired} from '../../lib/pending';
import {evaluateSetup, type Candle} from '../../lib/strategy';
import {finalPreOrderSafetyCheck, type FinalPreOrderDependencies} from '../../lib/runtime/final-preorder';
import {workerHarness} from './worker-harness';

const T0=1200, resolution=300;
function sequence(direction:'long'|'short') {
  const prefix=(direction==='long'?[90,92,94,96]:[110,108,106,104])
    .map((close,i)=>({time:i*resolution,open:close,high:close+1,low:close-1,close}));
  const signal:Candle=direction==='long'
    ? {time:T0,open:97,high:101,low:96,close:100}
    : {time:T0,open:103,high:104,low:99,close:100};
  return [...prefix,signal];
}
const neutral=(index:number):Candle=>({time:T0+index*resolution,open:100,high:100,low:100,close:100});
// Processing time is after the identified candle completes, including publication grace.
const observedAt=(index:number)=>T0+(index+1)*resolution+2;

for (const direction of ['long','short'] as const) {
  const trigger=direction==='long'?101:99, sl=direction==='long'?96:104;
  const beyond=direction==='long'?102:98;
  test(`GOLDEN ${direction}: real worker signal → T0 blocked → T1 order → original protection`,async()=>{
    const worker=workerHarness(),history=sequence(direction);
    const signal=history.at(-1)!;
    await worker.cycle(observedAt(0),history,beyond);
    const pending=worker.inspect().pending;
    assert.ok(pending);
    assert.equal(pending.candleTime,signal.time);
    assert.equal(pending.direction,direction);
    assert.equal(pending.trigger,trigger);
    assert.equal(pending.sl,sl);
    assert.equal(pending.expiresAfterCandleTime,T0+3*resolution);
    const log=worker.status().logs.find((row:any)=>row.candleTime===T0);
    assert.equal(log.ema.direction,direction==='long'?'UP':'DOWN');
    assert.equal(log[direction==='long'?'buy':'sell'].patternA,true);
    assert.equal(log[direction==='long'?'buy':'sell'].patternB,false);
    assert.equal(worker.orders.length,0,'T0 must never submit its own setup');
    assert.equal(worker.intents.length,0);
    assert.equal(worker.leverages.length,0,'T0 must not reach the execution path');
    // A second runtime cycle with the same identity must still be ineligible.
    await worker.cycle(observedAt(0)+1,history,beyond);
    assert.equal(worker.orders.length,0);
    assert.equal(worker.leverages.length,0);

    await worker.cycle(observedAt(1),[...history,neutral(1)],beyond);
    assert.equal(worker.orders.length,1);
    assert.equal(worker.orders[0].side,direction==='long'?'buy':'sell');
    assert.equal(worker.orders[0].productId,27);
    assert.equal(worker.orders[0].contracts,20);
    assert.deepEqual(worker.leverages,[50]);
    assert.equal(worker.intents[0].trigger,trigger);
    assert.equal(worker.intents[0].sl,sl);
    assert.equal(worker.intents[0].riskAmount,10); // 1% of available 1000, not equity 99999
    assert.equal(worker.intents[0].contractValue,0.1);
    assert.equal(worker.brackets.length,1);
    assert.equal(worker.brackets[0].sl,sl);
    assert.equal(worker.brackets[0].tp,direction==='long'?111:89);
    assert.equal(worker.brackets[0].triggerMethod,'last_traded_price');
    assert.equal(worker.persisted[0].trigger,trigger);
    assert.equal(worker.persisted[0].actualEntryPrice,beyond);
    assert.equal(worker.persisted[0].tp,direction==='long'?111:89,'RR remains trigger based despite fill slippage');
    assert.ok(direction==='long'
      ? worker.brackets[0].sl<trigger&&worker.brackets[0].tp>trigger
      : worker.brackets[0].sl>trigger&&worker.brackets[0].tp<trigger);
    assert.equal(worker.inspect().pending,null);
  });

  test(`${direction}: strict breakout equality does not enter on eligible T1`,async()=>{
    const worker=workerHarness(),history=sequence(direction);
    await worker.cycle(observedAt(0),history,beyond);
    await worker.cycle(observedAt(1),[...history,neutral(1)],trigger);
    assert.equal(worker.orders.length,0);
    assert.equal(worker.leverages.length,0);
    await worker.cycle(observedAt(1)+1,[...history,neutral(1)],beyond);
    assert.equal(worker.orders.length,1);
  });

  test(`${direction}: T2 breakout remains eligible with entryValidCandles=2`,async()=>{
    const worker=workerHarness(),history=sequence(direction);
    await worker.cycle(observedAt(0),history,beyond);
    await worker.cycle(observedAt(1),[...history,neutral(1)],trigger);
    assert.equal(worker.orders.length,0);
    await worker.cycle(observedAt(2),[...history,neutral(1),neutral(2)],beyond);
    assert.equal(worker.orders.length,1);
    assert.equal(worker.brackets[0].sl,sl);
  });

  test(`${direction}: T3 breakout is expired and cannot submit`,async()=>{
    const worker=workerHarness(),history=sequence(direction);
    await worker.cycle(observedAt(0),history,trigger);
    for(let i=1;i<=3;i++) {
      history.push(neutral(i));
      await worker.cycle(observedAt(i),history,i===3?beyond:trigger);
    }
    assert.equal(worker.orders.length,0);
    assert.equal(worker.inspect().pending,null);
    assert.ok(worker.inspect().tradeEvents.some((event:any)=>event.type==='PENDING_SETUP_EXPIRED'));
  });

  for(const opposite of [false,true]) {
    test(`${direction}: ${opposite?'opposite':'same'} new signal and wider T1/T2 ranges cannot replace pending`,async()=>{
      const worker=workerHarness(),history=sequence(direction);
      await worker.cycle(observedAt(0),history,trigger);
      const original=worker.inspect().pending;
      const nextDirection=opposite?(direction==='long'?'short':'long'):direction;
      const next:Candle={time:T0+resolution,open:100,high:200,low:10,close:nextDirection==='long'?110:90};
      assert.equal(evaluateSetup([...history,next],2,1)?.direction,nextDirection,'fixture must be an otherwise valid new signal');
      history.push(next);
      await worker.cycle(observedAt(1),history,trigger);
      assert.equal(worker.inspect().pending,original);
      history.push({...neutral(2),high:300,low:1});
      await worker.cycle(observedAt(2),history,trigger);
      assert.equal(worker.inspect().pending,original);
      assert.equal(original.direction,direction);
      assert.equal(original.candleTime,T0);
      assert.equal(original.trigger,trigger);
      assert.equal(original.sl,sl);
      assert.equal(worker.orders.length,0);
    });
  }

  for(const count of [1,2,3]) {
    test(`${direction}: exactly the following ${count} candle identities are eligible`,async()=>{
      const setup={direction,trigger,sl,candleTime:T0};
      assert.equal(pendingEntryEligible(setup,T0,count,resolution),false);
      assert.equal(pendingEntryEligible(setup,T0+resolution-1,count,resolution),false);
      for(let index=1;index<=count+1;index++) {
        assert.equal(pendingEntryEligible(setup,T0+index*resolution,count,resolution),index<=count);
        assert.equal(pendingSetupExpired(setup,T0+index*resolution,count,resolution),index>count);
        const worker=workerHarness({entryValidCandles:count}),history=sequence(direction);
        await worker.cycle(observedAt(0),history,beyond);
        for(let i=1;i<=index;i++) {
          history.push(neutral(i));
          await worker.cycle(observedAt(i),history,i===index?beyond:trigger);
        }
        assert.equal(worker.orders.length,index<=count?1:0);
        assert.equal(worker.inspect().pending,null);
      }
      assert.equal(pendingEntryEligible(setup,T0+(count+1)*resolution-1,count,resolution),true);
    });
  }
}

test('expired pending permits a new opposite signal, but the new signal cannot enter itself',async()=>{
  const worker=workerHarness(),history=sequence('long');
  await worker.cycle(observedAt(0),history,101);
  history.push(neutral(1),neutral(2));
  const replacement:Candle={time:T0+3*resolution,open:100,high:105,low:85,close:90};
  history.push(replacement);
  await worker.cycle(observedAt(3),history,84);
  assert.equal(worker.inspect().pending.direction,'short');
  assert.equal(worker.inspect().pending.trigger,85);
  assert.equal(worker.inspect().pending.sl,105);
  assert.equal(worker.inspect().pending.candleTime,replacement.time);
  assert.equal(worker.orders.length,0);
});

test('final order barrier independently blocks T0, permits T1/T2, and rejects T3',async()=>{
  const setup={direction:'long' as const,trigger:100,sl:90,candleTime:T0,configRevision:'rev'};
  const config={revision:'rev',autoTrade:true,entryValidCandles:2,resolutionSec:resolution,riskPct:1,rr:2,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:20,gstPct:18};
  const input={identity:{portfolioId:'p',environment:'demo' as const,symbol:'XAUTUSD',productId:27},setup,config,product:{id:27,contractValue:0.1,tickSize:0.5,takerRate:0.0005}};
  for(const index of [0,1,2,3]) {
    let marketCalls=0;
    const deps:FinalPreOrderDependencies={robotRunning:()=>true,refreshConfig:async()=>config,currentPending:()=>setup,
      latestCompletedCandleTime:()=>T0+index*resolution,leaseOwned:async()=>true,leaseLost:()=>false,portfolioEntryAllowed:async()=>true,
      portfolio:async()=>({id:'p',environment:'demo',symbol:'XAUTUSD',productId:27}),position:async()=>({size:0}),availableMargin:async()=>1000};
    const result=await finalPreOrderSafetyCheck(input,deps);
    if(result.ok)marketCalls++;
    assert.equal(marketCalls,index===1||index===2?1:0);
    if(!result.ok)assert.equal(result.reason,index===0?'FINAL_PREORDER_SIGNAL_CANDLE':'FINAL_PREORDER_PENDING_EXPIRED');
  }
});
