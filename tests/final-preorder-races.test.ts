import assert from 'node:assert/strict';
import test from 'node:test';
import {finalPreOrderDispatchStateCheck,finalPreOrderSafetyCheck,type FinalPreOrderDependencies,type FinalPreOrderInput} from '../lib/runtime/final-preorder';
import {EntryNotTransmittedError,submitPreparedEntryIntent,type EntryIntentDependencies} from '../lib/entry-intents/service';

function harness(direction:'long'|'short'='long') {
  const input:FinalPreOrderInput={
    identity:{portfolioId:'p',environment:'demo',symbol:'TEST',productId:27},
    setup:{direction,trigger:100,sl:direction==='long'?90:110,candleTime:1200,configRevision:'a'},
    config:{revision:'a',autoTrade:true,entryValidCandles:2,resolutionSec:300,riskPct:1,rr:2,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:100,gstPct:18},
    product:{id:27,contractValue:0.3,tickSize:0.5,takerRate:0.0005}
  };
  const state={running:true,shutdown:false,config:{...input.config},pending:{...input.setup} as typeof input.setup|null,
    candleTime:1800,accountOwned:true,leaseLost:false,portfolioOwned:true,dailyAllowed:true,
    portfolio:{id:'p',environment:'demo',symbol:'TEST',productId:27} as Awaited<ReturnType<FinalPreOrderDependencies['portfolio']>>,
    position:{size:0} as unknown};
  let duringMargin=()=>{},afterPreparation=()=>{};
  const deps:FinalPreOrderDependencies={
    robotRunning:()=>state.running&&!state.shutdown,refreshConfig:async()=>({...state.config}),currentConfig:()=>state.config,
    currentPending:()=>state.pending,latestCompletedCandleTime:()=>state.candleTime,
    leaseOwned:async()=>state.accountOwned,leaseLost:()=>state.leaseLost,portfolioEntryAllowed:async()=>state.portfolioOwned,
    portfolio:async()=>state.portfolio,position:async()=>state.position,dailyLossEntryAllowed:()=>state.dailyAllowed,
    availableMargin:async()=>{duringMargin();return 1000;}
  };
  let marketCalls=0;
  // Run the real durable-intent service; a safety rejection must not reach transport
  // or be classified as an ambiguous transmitted order.
  const intent:any={intentId:'audit',clientOrderId:'audit-client',portfolioId:'p',productId:27};
  const intentDeps:EntryIntentDependencies={
    prepare:async()=>({...intent,state:'PREPARED'}),claim:async()=>({...intent,state:'SUBMITTING'}),
    reset:async()=>{},confirmed:async()=>({...intent,state:'CONFIRMED'}),
    ambiguous:async()=>assert.fail('known safety rejection must not become ambiguous'),
    touch:async()=>{},unresolved:async()=>[],lookup:async()=>null
  };
  return {input,state,deps,onMargin:(fn:()=>void)=>{duringMargin=fn;},afterPreparation:(fn:()=>void)=>{afterPreparation=fn;},
    async dispatch(){
      const result=await submitPreparedEntryIntent(intent,async clientOrderId=>{
        const safety=await finalPreOrderSafetyCheck(input,deps);
        if(!safety.ok)throw new EntryNotTransmittedError(safety.reason);
        afterPreparation();
        const last=finalPreOrderDispatchStateCheck(input,deps);
        if(!last.ok)throw new EntryNotTransmittedError(last.reason);
        marketCalls++;
        return {result:{id:'exchange-order',client_order_id:clientOrderId,product_id:27}};
      },intentDeps);
      return {result,marketCalls};
    }
  };
}
type State=ReturnType<typeof harness>['state'];
const changes:Array<[string,(s:State)=>void,string]>=[
  ['Robot STOP',s=>{s.running=false;},'FINAL_PREORDER_ROBOT_STOPPED'],
  ['shutdown',s=>{s.shutdown=true;},'FINAL_PREORDER_ROBOT_STOPPED'],
  ['AUTO_TRADE OFF',s=>{s.config.autoTrade=false;},'FINAL_PREORDER_AUTO_TRADE_OFF'],
  ['config revision',s=>{s.config.revision='b';},'FINAL_PREORDER_CONFIG_CHANGED'],
  ['pending removed',s=>{s.pending=null;},'FINAL_PREORDER_PENDING_REPLACED'],
  ['T3 expiry',s=>{s.candleTime=2100;},'FINAL_PREORDER_PENDING_EXPIRED'],
  ['account ownership',s=>{s.accountOwned=false;},'FINAL_PREORDER_LEASE_LOST'],
  ['account heartbeat loss',s=>{s.leaseLost=true;},'FINAL_PREORDER_LEASE_LOST'],
  ['portfolio lease',s=>{s.portfolioOwned=false;},'FINAL_PREORDER_DELETION_IN_PROGRESS'],
  ['portfolio removed',s=>{s.portfolio=null;},'FINAL_PREORDER_PORTFOLIO_MISMATCH'],
  ['portfolio environment',s=>{s.portfolio!.environment='real';},'FINAL_PREORDER_PORTFOLIO_MISMATCH'],
  ['portfolio product',s=>{s.portfolio!.productId=28;},'FINAL_PREORDER_PORTFOLIO_MISMATCH'],
  ['portfolio symbol',s=>{s.portfolio!.symbol='OTHER';},'FINAL_PREORDER_PORTFOLIO_MISMATCH'],
  ['portfolio identity',s=>{s.portfolio!.id='other';},'FINAL_PREORDER_PORTFOLIO_MISMATCH'],
  ['LONG position appears',s=>{s.position={size:2};},'FINAL_PREORDER_POSITION_NONZERO'],
  ['SHORT position appears',s=>{s.position={size:-2};},'FINAL_PREORDER_POSITION_NONZERO'],
  ['position evidence disappears',s=>{s.position=null;},'FINAL_PREORDER_POSITION_INVALID'],
  ['daily-loss gate',s=>{s.dailyAllowed=false;},'FINAL_PREORDER_DAILY_LOSS_BLOCKED']
];
for(const field of ['direction','trigger','sl','candleTime','configRevision'] as const) {
  changes.push([`pending ${field}`,s=>{s.pending={...s.pending!,[field]:field==='direction'?(s.pending!.direction==='long'?'short':'long'):field==='configRevision'?'b':s.pending![field]+1};},'FINAL_PREORDER_PENDING_REPLACED']);
}
for(const direction of ['long','short'] as const)for(const [name,change,reason] of changes) {
  test(`${direction}: ${name} during margin preparation prevents dispatch`,async()=>{
    const h=harness(direction);h.onMargin(()=>change(h.state));
    const {result,marketCalls}=await h.dispatch();
    assert.equal(marketCalls,0);assert.equal(result.status,'REJECTED');
    assert.equal((result as {error?:Error}).error?.message,reason);
  });
}

const invalidPositions:unknown[]=[null,undefined,{},[],[{size:0}],0,'0',{size:null},{size:undefined},{size:''},{size:' '},{size:'abc'},{size:NaN},{size:Infinity},{size:-Infinity},{size:'NaN'},{size:'Infinity'},{size:false},{size:[]},{size:{}},{size:'0x0'},{size:'1e-9999'}];
for(const [i,position] of invalidPositions.entries())test(`invalid position shape ${i} fails closed`,async()=>{
  const h=harness();h.state.position=position;
  const {result,marketCalls}=await h.dispatch();
  assert.equal(marketCalls,0);assert.equal(result.status,'REJECTED');
  assert.equal((result as {error?:Error}).error?.message,'FINAL_PREORDER_POSITION_INVALID');
});
for(const size of [0,'0','0.0','-0',2,-2,'2','-2'])test(`explicit position size ${JSON.stringify(size)} requires flat`,async()=>{
  const h=harness();h.state.position={size};const {result,marketCalls}=await h.dispatch();
  assert.equal(marketCalls,Number(size)===0?1:0);
  assert.equal(result.status,Number(size)===0?'CONFIRMED':'REJECTED');
});

for(const [name,change,reason] of changes.filter(([name])=>['Robot STOP','shutdown','AUTO_TRADE OFF','config revision','pending removed','T3 expiry','account heartbeat loss','daily-loss gate'].includes(name))) {
  test(`${name} during last remote revalidation is caught after all awaits`,async()=>{
    const h=harness();let reads=0;
    h.deps.position=async()=>{if(++reads===2)change(h.state);return {size:0};};
    const {result,marketCalls}=await h.dispatch();assert.equal(marketCalls,0);
    assert.equal((result as {error?:Error}).error?.message,reason);
  });
  test(`${name} at dispatch continuation is caught without another await`,async()=>{
    const h=harness();h.afterPreparation(()=>change(h.state));
    const {result,marketCalls}=await h.dispatch();assert.equal(marketCalls,0);
    assert.equal((result as {error?:Error}).error?.message,reason);
  });
}
for(const [index,allowed] of [[0,false],[1,true],[2,true],[3,false]] as const)test(`unchanged T${index} dispatch eligibility`,async()=>{
  const h=harness();h.state.candleTime=1200+index*300;
  const {marketCalls}=await h.dispatch();assert.equal(marketCalls,allowed?1:0);
});
for(const direction of ['long','short'] as const)test(`${direction}: final revalidation preserves sizing and protection numbers`,async()=>{
  const h=harness(direction);const result=await finalPreOrderSafetyCheck(h.input,h.deps);assert.ok(result.ok);
  assert.equal(result.riskAmount,10);assert.equal(result.stopDistance,10);assert.equal(result.contracts,3);
  assert.ok(Math.abs(result.notional-90)<1e-12);assert.ok(Math.abs(result.effectiveLeverage-0.09)<1e-12);
  assert.equal(result.sl,direction==='long'?90:110);assert.equal(result.tp,direction==='long'?120:80);
  const fees=direction==='long'?0.099:0.081;
  assert.ok(Math.abs(result.feeBeforeGST-fees)<1e-12);assert.ok(Math.abs(result.estimatedFees-fees*1.18)<1e-12);
});
