import assert from 'node:assert/strict';
import test from 'node:test';
import { finalPreOrderSafetyCheck, type FinalPreOrderDependencies, type FinalPreOrderInput } from '../../lib/runtime/final-preorder';

const input:FinalPreOrderInput={
  identity:{portfolioId:'contract',environment:'demo',symbol:'XAUTUSD',productId:27},
  setup:{direction:'long',trigger:100,sl:90,candleTime:1200,configRevision:'contract'},
  config:{revision:'contract',autoTrade:true,entryValidCandles:2,resolutionSec:300,riskPct:1,rr:2,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:100,gstPct:18},
  product:{id:27,contractValue:0.3,tickSize:0.5,takerRate:0.0005}
};
const dependencies=(candidate:FinalPreOrderInput,available=1000):FinalPreOrderDependencies=>({
  robotRunning:()=>true,refreshConfig:async()=>candidate.config,currentPending:()=>candidate.setup,
  latestCompletedCandleTime:()=>1500,leaseOwned:async()=>true,leaseLost:()=>false,
  portfolioEntryAllowed:async()=>true,portfolio:async()=>({id:'contract',environment:'demo',symbol:'XAUTUSD',productId:27}),
  position:async()=>({size:0}),availableMargin:async()=>available
});

test('risk contract: available margin, flooring, RR, effective leverage and taker/GST fees',async()=>{
  const result=await finalPreOrderSafetyCheck(input,dependencies(input));
  assert.ok(result.ok);
  assert.equal(result.riskAmount,10);
  assert.equal(result.stopDistance,10);
  assert.equal(result.stopPct,10);
  assert.equal(result.contracts,3); // floor(10 / 10 / 0.3), never round up to 4
  assert.equal(result.tp,120);
  assert.equal(result.sl,90);
  assert.ok(Math.abs(result.notional-90)<1e-12);
  assert.ok(Math.abs(result.effectiveLeverage-0.09)<1e-12);
  assert.ok(Math.abs(result.feeBeforeGST-0.099)<1e-12);
  assert.ok(Math.abs(result.estimatedFees-0.11682)<1e-12);
  assert.ok(Math.abs(result.feeRiskPct-1.1682)<1e-12);
});

test('risk contract: min-stop equality passes, below minimum rejects without resizing',async()=>{
  const equal={...input,config:{...input.config,minStopPct:10}};
  assert.equal((await finalPreOrderSafetyCheck(equal,dependencies(equal))).ok,true);
  const below={...input,config:{...input.config,minStopPct:10.01}};
  assert.deepEqual(await finalPreOrderSafetyCheck(below,dependencies(below)),{ok:false,reason:'FINAL_PREORDER_RISK_GUARD',guard:'STOP_TOO_TIGHT'});
});

test('risk contract: effective leverage equality passes; excess rejects, never caps size',async()=>{
  const base={...input,product:{...input.product,contractValue:1}};
  const equal={...base,config:{...base.config,maxEffectiveLeverage:0.1}};
  assert.equal((await finalPreOrderSafetyCheck(equal,dependencies(equal))).ok,true);
  const exceeded={...equal,config:{...equal.config,maxEffectiveLeverage:0.099}};
  assert.deepEqual(await finalPreOrderSafetyCheck(exceeded,dependencies(exceeded)),{ok:false,reason:'FINAL_PREORDER_RISK_GUARD',guard:'LEVERAGE_TOO_HIGH'});
});

test('risk contract: fee/risk equality passes; excess rejects',async()=>{
  const base=await finalPreOrderSafetyCheck(input,dependencies(input));
  assert.ok(base.ok);
  const equal={...input,config:{...input.config,maxFeeRiskPct:base.feeRiskPct}};
  assert.equal((await finalPreOrderSafetyCheck(equal,dependencies(equal))).ok,true);
  const exceeded={...input,config:{...input.config,maxFeeRiskPct:base.feeRiskPct-0.00001}};
  assert.deepEqual(await finalPreOrderSafetyCheck(exceeded,dependencies(exceeded)),{ok:false,reason:'FINAL_PREORDER_RISK_GUARD',guard:'FEES_TOO_HIGH'});
});

test('risk contract: SL/TP use nearest tick while risk retains original signal range',async()=>{
  const candidate={...input,setup:{...input.setup,sl:90.26},config:{...input.config,rr:1.3}};
  const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
  assert.ok(result.ok);
  assert.ok(Math.abs(result.stopDistance-9.74)<1e-12);
  assert.equal(result.sl,90.5);
  assert.equal(result.tp,112.5);
});
