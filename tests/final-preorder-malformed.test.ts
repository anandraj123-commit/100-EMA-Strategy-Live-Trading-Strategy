import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalPreOrderSafetyCheck,
  type FinalPreOrderDependencies,
  type FinalPreOrderInput
} from '../lib/runtime/final-preorder';

const pending={direction:'long' as const,trigger:100,sl:90,candleTime:1_000,configRevision:'rev'};
const input:FinalPreOrderInput={
  identity:{portfolioId:'malformed-boundary',environment:'demo',symbol:'BTCUSD',productId:27},
  setup:pending,
  config:{revision:'rev',autoTrade:true,entryValidCandles:2,resolutionSec:60,riskPct:1,rr:8,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:100,gstPct:18},
  product:{id:27,contractValue:1,tickSize:0.01,takerRate:0.0005}
};

const dependencies=(candidate:FinalPreOrderInput=input):FinalPreOrderDependencies=>({
  robotRunning:()=>true,
  refreshConfig:async()=>candidate.config,
  currentPending:()=>candidate.setup,
  latestCompletedCandleTime:()=>1_059,
  leaseOwned:async()=>true,
  leaseLost:()=>false,
  portfolioEntryAllowed:async()=>true,
  portfolio:async()=>({id:candidate.identity.portfolioId,environment:candidate.identity.environment,symbol:candidate.identity.symbol,productId:candidate.identity.productId}),
  position:async()=>({size:0}),
  availableMargin:async()=>1_000
});

test('final barrier rejects a NaN entry trigger instead of authorizing transmission',async()=>{
  const candidate={...input,setup:{...pending,trigger:Number.NaN}};
  const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
  assert.equal(result.ok,false);
});

test('final barrier rejects a non-positive entry trigger instead of authorizing transmission',async()=>{
  for(const trigger of [0,-100]){
    const candidate={...input,setup:{...pending,trigger}};
    const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
    assert.equal(result.ok,false);
  }
});

test('final barrier rejects missing, non-finite, or non-positive contract value',async()=>{
  for(const contractValue of [undefined,Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY,0,-1]){
    const candidate={...input,product:{...input.product,contractValue}} as FinalPreOrderInput;
    const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
    assert.equal(result.ok,false);
  }
});

test('final barrier rejects missing, non-finite, or non-positive tick size',async()=>{
  for(const tickSize of [undefined,Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY,0,-0.01]){
    const candidate={...input,product:{...input.product,tickSize}} as FinalPreOrderInput;
    const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
    assert.equal(result.ok,false);
  }
});

test('final barrier rejects NaN and infinite safety calculations',async()=>{
  for(const candidate of [
    {...input,product:{...input.product,takerRate:Number.NaN}},
    {...input,config:{...input.config,riskPct:Number.POSITIVE_INFINITY}}
  ])assert.equal((await finalPreOrderSafetyCheck(candidate,dependencies(candidate))).ok,false);
});

test('LONG normalized protection must remain strictly outside the entry price',async()=>{
  for(const candidate of [
    {...input,setup:{...pending,sl:99.999},product:{...input.product,tickSize:1}},
    {...input,config:{...input.config,rr:0}}
  ])assert.equal((await finalPreOrderSafetyCheck(candidate,dependencies(candidate))).ok,false);
});

test('SHORT normalized protection must remain strictly outside the entry price',async()=>{
  const short={...pending,direction:'short' as const,sl:110};
  for(const candidate of [
    {...input,setup:{...short,sl:100.001},product:{...input.product,tickSize:1}},
    {...input,setup:short,config:{...input.config,rr:0}}
  ])assert.equal((await finalPreOrderSafetyCheck(candidate,dependencies(candidate))).ok,false);
});

test('valid LONG calculations remain unchanged',async()=>{
  const result=await finalPreOrderSafetyCheck(input,dependencies(input));
  assert.equal(result.ok,true);
  if(result.ok)assert.deepEqual({available:result.available,riskAmount:result.riskAmount,contracts:result.contracts,notional:result.notional,effectiveLeverage:result.effectiveLeverage,sl:result.sl,tp:result.tp},{available:1_000,riskAmount:10,contracts:1,notional:100,effectiveLeverage:0.1,sl:90,tp:180});
});

test('valid SHORT calculations remain unchanged',async()=>{
  const candidate={...input,setup:{...pending,direction:'short' as const,sl:110}};
  const result=await finalPreOrderSafetyCheck(candidate,dependencies(candidate));
  assert.equal(result.ok,true);
  if(result.ok)assert.deepEqual({available:result.available,riskAmount:result.riskAmount,contracts:result.contracts,notional:result.notional,effectiveLeverage:result.effectiveLeverage,sl:result.sl,tp:result.tp},{available:1_000,riskAmount:10,contracts:1,notional:100,effectiveLeverage:0.1,sl:110,tp:20});
});
