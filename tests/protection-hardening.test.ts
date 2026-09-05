import assert from 'node:assert/strict';
import test from 'node:test';
import { DeltaRequestError, getOpenOrders } from '../lib/delta';
import { inspectProtectionForSync, planProtectionSync, protectionTriggerMethod, protectionTriggerPrice, type ProtectionExpectation } from '../lib/trades/protection';
import { reconcileProtection, type ProtectionDependencies, type ProtectionTrade } from '../lib/trades/protection-reconciliation';

const expected = (direction: 'long' | 'short' = 'long'): ProtectionExpectation => ({
  productId:27, direction, contracts:117, sl:direction === 'long' ? 90 : 110,
  tp:direction === 'long' ? 120 : 80, triggerMethod:'last_traded_price',
});
function order(leg: 'sl' | 'tp', e = expected(), overrides: Record<string, unknown> = {}) {
  return {id:leg, product_id:e.productId, side:e.direction === 'long' ? 'sell' : 'buy',
    size:e.contracts, unfilled_size:e.contracts, reduce_only:true, order_type:'market_order',
    stop_order_type:leg === 'sl' ? 'stop_loss_order' : 'take_profit_order',
    stop_price:String(e[leg]), stop_trigger_method:e.triggerMethod, state:'pending', ...overrides};
}
const pair = (e = expected()) => [order('sl',e),order('tp',e)];
function harness(direction: 'long' | 'short' = 'long') {
  const e = expected(direction);
  const trade: ProtectionTrade = {tradeId:'bot:test', source:'bot', attributionStatus:'BOT_CONFIRMED',
    direction, ownedContracts:e.contracts, contracts:e.contracts, sl:e.sl, tp:e.tp, mixedPosition:false, protectionState:'ACTIVE'};
  let currentTrade: ProtectionTrade | null = trade;
  let rows: any[] = pair(e);
  let position: any = {product_id:e.productId, size:direction === 'long' ? e.contracts : -e.contracts};
  let price: number | null = 100;
  const events: Array<Record<string, any>> = [], submissions: any[] = [], persisted: any[] = [];
  const deps: ProtectionDependencies = {
    trade:() => currentTrade,
    position:async () => position,
    orders:async () => rows,
    triggerPrice:async () => price,
    ownership:async () => true,
    persist:async (_id, values) => { persisted.push(values); },
    bracket:async (sl,tp) => {submissions.push({kind:'bracket',sl,tp}); rows=pair(e);},
    stop:async (side,size,leg,trigger,clientOrderId) => {submissions.push({kind:'stop',side,size,leg,trigger,clientOrderId}); rows=[...rows,order(leg,e)];},
    event:(type,details) => events.push({type,...details}), repairAttempts:new Set(), now:() => 10000,
  };
  return {e,trade,deps,events,submissions,persisted, run:() => reconcileProtection(e.productId,e.triggerMethod,deps),
    setRows:(value:any[]) => {rows=value;}, setPosition:(value:any) => {position=value;},
    setPrice:(value:number|null) => {price=value;}, setTrade:(value:ProtectionTrade|null) => {currentTrade=value;}};
}

for (const direction of ['long','short'] as const) {
  test(`valid ${direction} market protection is accepted without repair`,async () => {
    const h=harness(direction); await h.run();
    assert.equal(h.trade.protectionState,'ACTIVE'); assert.equal(h.submissions.length,0);
    assert.equal(h.trade.exchangeSync.status,'VALID');
  });
  for (const leg of ['sl','tp'] as const) {
    test(`${direction} ${leg} at or beyond its trigger is never recreated`,async () => {
      for (const beyond of [false,true]) {
        const h=harness(direction); h.setRows([order(leg === 'sl' ? 'tp' : 'sl',h.e)]);
        const increment=(direction === 'long') === (leg === 'sl') ? -1 : 1;
        h.setPrice(h.e[leg]! + (beyond ? increment : 0)); await h.run();
        assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
        assert.ok(h.events.some(event => event.type === 'PROTECTION_REPAIR_BLOCKED_TRIGGER_BREACHED'));
      }
    });
  }
}
for (const [field,value] of Object.entries({side:'buy',size:116,unfilled_size:116,reduce_only:false,order_type:'limit_order',stop_trigger_method:'mark_price',state:'closed',stop_price:0})) {
  test(`invalid ${field} blocks ACTIVE and blind repair`,async () => {
    const h=harness(); h.setRows([order('sl',h.e,{[field]:value}),order('tp',h.e)]); await h.run();
    assert.equal(h.trade.protectionState,'REPAIR_REQUIRED'); assert.equal(h.submissions.length,0);
    assert.ok(h.events.some(event => event.reason?.includes(field)));
  });
}
for (const field of ['side','size','reduce_only','order_type','stop_trigger_method','state','id']) {
  test(`absent ${field} is UNVERIFIABLE, not a mismatch or a missing order`,async () => {
    const h=harness(), sl:any=order('sl',h.e); delete sl[field];
    const inspection=inspectProtectionForSync([sl,order('tp',h.e)],h.e);
    assert.equal(inspection.status,'UNVERIFIABLE'); assert.deepEqual(inspection.missing,[]);
    h.setRows([sl,order('tp',h.e)]); await h.run();
    assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  });
}
test('optional unfilled size may be absent; documented string reduce-only true is accepted',() => {
  const rows=pair().map(row=>({...row,unfilled_size:undefined,reduce_only:'true'}));
  assert.equal(inspectProtectionForSync(rows,expected()).status,'VALID');
});
test('malformed side, boolean quantity, and false-like reduce-only metadata are invalid',() => {
  for (const overrides of [{side:''},{side:42},{size:true},{reduce_only:'false'},{reduce_only:1}]) {
    assert.equal(inspectProtectionForSync([order('sl',expected(),overrides),order('tp')],expected()).status,'INVALID');
  }
});
test('bracket summary fields do not prove child protection or authorize duplicate repair',async () => {
  const h=harness(); h.setRows([{product_id:27,bracket_stop_loss_price:90,bracket_take_profit_price:120}]);
  await h.run(); assert.equal(h.submissions.length,0); assert.equal(h.trade.exchangeSync.status,'UNVERIFIABLE');
});
test('unknown protection kind does not become evidence of missing protection',async () => {
  const h=harness(); h.setRows([order('sl',h.e,{stop_order_type:'unknown'}),order('tp',h.e)]);
  await h.run(); assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
});
test('safe exchange price changes remain synchronized; unsafe changes are not adopted',async () => {
  const h=harness(); h.setRows([order('sl',h.e,{stop_price:95}),order('tp',h.e,{stop_price:125})]);
  await h.run(); assert.deepEqual([h.trade.sl,h.trade.tp],[95,125]); assert.equal(h.trade.protectionState,'ACTIVE');
  const unsafe=harness(); unsafe.setRows([order('sl',unsafe.e,{stop_price:101}),order('tp',unsafe.e)]);
  await unsafe.run(); assert.equal(unsafe.trade.sl,90); assert.equal(unsafe.trade.protectionState,'REPAIR_REQUIRED');
});
test('post-repair price mismatch cannot be adopted as a successful repair',async () => {
  const h=harness(); h.setRows([]); h.deps.bracket=async () => {h.submissions.push('bracket');h.setRows([order('sl',h.e,{stop_price:91}),order('tp',h.e)]);};
  await h.run(); assert.equal(h.trade.sl,90); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  await h.run(); assert.equal(h.trade.sl,90); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
});
test('crossed intended SL/TP are never repaired',async () => {
  const h=harness(); h.trade.sl=130; h.setRows([]); await h.run(); assert.equal(h.submissions.length,0);
});
test('missing unbreached leg is repaired with unchanged contracts, price, and side',async () => {
  const h=harness('short'); h.setRows([order('tp',h.e)]); await h.run();
  assert.equal(h.submissions.length,1);
  assert.deepEqual({...h.submissions[0],clientOrderId:undefined},{kind:'stop',side:'buy',size:117,leg:'sl',trigger:110,clientOrderId:undefined});
  assert.equal(h.trade.protectionState,'ACTIVE');
});
test('both missing legs follow bracket repair and exchangeSync uses post-repair values',async () => {
  const h=harness(); h.setRows([]); await h.run();
  assert.deepEqual(h.submissions,[{kind:'bracket',sl:90,tp:120}]); assert.equal(h.trade.protectionState,'ACTIVE');
  assert.deepEqual(h.trade.exchangeSync,{at:'1970-01-01T00:00:10.000Z',sl:90,tp:120,status:'VALID'});
  assert.ok(h.events.some(event=>event.type==='PROTECTION_REPAIRED'));
});
for (const change of ['flat','direction','quantity','product','owned','attribution','mixed','identity','trade']) {
  test(`pre-repair ${change} change aborts submission`,async () => {
    const h=harness(); h.setRows([]); let calls=0;
    h.deps.position=async () => {
      calls++;
      if(calls===2) {
        if(change==='flat')return {product_id:27,size:0};
        if(change==='direction')return {product_id:27,size:-117};
        if(change==='quantity')return {product_id:27,size:116};
        if(change==='product')return {product_id:28,size:117};
        if(change==='owned')h.trade.ownedContracts=116;
        if(change==='attribution')h.trade.attributionStatus='UNKNOWN';
        if(change==='mixed')h.trade.mixedPosition=true;
        if(change==='identity')h.trade.tradeId='another';
        if(change==='trade')h.setTrade({...h.trade});
      }
      return {product_id:27,size:117};
    };
    await h.run(); assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  });
}
test('ownership gate is repeated before repair without changing attribution',async () => {
  const h=harness(); h.setRows([]); let calls=0; h.deps.ownership=async()=>++calls===1;
  await h.run(); assert.equal(h.submissions.length,0); assert.equal(h.trade.attributionStatus,'BOT_CONFIRMED');
});
test('post-repair missing evidence is not ACTIVE and does not loop-create duplicates',async () => {
  const h=harness(); h.setRows([]); h.deps.bracket=async()=>{h.submissions.push('bracket');};
  await h.run(); await h.run();
  assert.equal(h.submissions.length,1); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  h.setRows(pair(h.e)); await h.run(); assert.equal(h.trade.protectionState,'ACTIVE'); assert.equal(h.deps.repairAttempts.size,0);
});
test('post-repair metadata is validated as strictly as existing protection',async () => {
  const h=harness(); h.setRows([]); h.deps.bracket=async()=>h.setRows([order('sl',h.e,{reduce_only:false}),order('tp',h.e)]);
  await h.run(); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  assert.ok(h.events.some(event=>event.type==='PROTECTION_VERIFICATION_FAILED'));
});
test('temporary order lookup failure never repairs, exposes safe details, and later recovers',async () => {
  const h=harness(); h.deps.orders=async()=>{throw new DeltaRequestError('DELTA_NETWORK_TIMEOUT');};
  await h.run(); assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  const event=h.events.find(event=>event.type==='PROTECTION_RECONCILIATION_FAILED');
  assert.equal(event?.stage,'ORDER_LOOKUP'); assert.equal(event?.code,'DELTA_NETWORK_TIMEOUT');
  assert.equal(event?.error,event?.message); assert.match(event?.reason,/ORDER_LOOKUP/);
  h.deps.orders=async()=>pair(h.e); await h.run(); assert.equal(h.trade.protectionState,'ACTIVE');
});
for (const stage of ['POSITION_LOOKUP','TRIGGER_PRICE_LOOKUP','PERSISTENCE','PRE_REPAIR_POSITION_CHECK','REPAIR_SUBMISSION','POST_REPAIR_VERIFICATION']) {
  test(`failure at ${stage} exposes its stage without original sensitive error text`,async () => {
    const h=harness(); const fail=async()=>{throw new Error('private-canary-do-not-publish');};
    if(stage==='POSITION_LOOKUP')h.deps.position=fail;
    if(stage==='TRIGGER_PRICE_LOOKUP'){h.setRows([]);h.deps.triggerPrice=fail;}
    if(stage==='PERSISTENCE')h.deps.persist=fail;
    if(stage==='PRE_REPAIR_POSITION_CHECK'){h.setRows([]);let count=0;h.deps.position=async()=>++count===1?{product_id:27,size:117}:fail();}
    if(stage==='REPAIR_SUBMISSION'){h.setRows([]);h.deps.bracket=fail;}
    if(stage==='POST_REPAIR_VERIFICATION'){h.setRows([]);let count=0;h.deps.orders=async()=>++count<=2?[]:fail();}
    await h.run();
    assert.equal(h.events.find(event=>event.type==='PROTECTION_RECONCILIATION_FAILED')?.stage,stage);
    assert.doesNotMatch(JSON.stringify(h.events),/private-canary-do-not-publish/);
    assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  });
}
test('unknown submission outcome blocks repeated repair but accepts later visible protection',async () => {
  const h=harness();h.setRows([]);h.deps.bracket=async()=>{h.submissions.push('attempt');throw new DeltaRequestError('DELTA_NETWORK_TIMEOUT');};
  await h.run(); await h.run(); assert.equal(h.submissions.length,1);
  h.setRows(pair(h.e)); await h.run(); assert.equal(h.trade.protectionState,'ACTIVE');
});
test('a newly visible leg before repair aborts the stale repair plan',async () => {
  const h=harness(); let calls=0;h.deps.orders=async()=>++calls===1?[]:pair(h.e);
  await h.run(); assert.equal(h.submissions.length,0);
});
test('trigger-source selection has no cross-source fallback',() => {
  assert.equal(protectionTriggerMethod('mark'),'mark_price'); assert.equal(protectionTriggerMethod('spot'),'spot_price');
  assert.equal(protectionTriggerPrice({close:100,mark_price:101,spot_price:102},'mark_price'),101);
  assert.equal(protectionTriggerPrice({close:100,spot_price:102},'mark_price'),null);
  assert.equal(protectionTriggerPrice({close:100},'last_traded_price'),100);
});
test('missing current trigger price blocks repair',async () => {
  const h=harness();h.setRows([]);h.setPrice(null);await h.run();assert.equal(h.submissions.length,0);
});
test('manual ownership gate and missing-price behavior are preserved',async () => {
  const h=harness();h.trade.source='exchange_existing';h.trade.attributionStatus='MANUAL_CONFIRMED';h.trade.tp=null;
  h.setRows([order('sl',h.e)]);await h.run();assert.equal(h.submissions.length,0);assert.equal(h.trade.tp,null);assert.equal(h.trade.protectionState,'ACTIVE');
  h.deps.ownership=async()=>false;h.setRows([]);await h.run();assert.equal(h.submissions.length,0);
});

const response = (result:any[], after:string|null=null) => ({success:true,result,meta:{after,before:null}});
test('complete empty active-order response is authoritative',async()=>{
  const rows=await getOpenOrders(27,async(method,path,params)=>{
    assert.equal(method,'GET');assert.equal(path,'/v2/orders');assert.equal(params?.product_ids,'27');assert.equal(params?.states,'open,pending');
    return response([]);
  }); assert.deepEqual(rows,[]);
});
test('active-order lookup consumes all pages before returning a snapshot',async()=>{
  let calls=0; const rows=await getOpenOrders(27,async(_method,_path,params)=>{
    calls++;if(calls===1)return response([order('sl')],'next');assert.equal(params?.after,'next');return response([order('tp')]);
  }); assert.equal(calls,2);assert.equal(rows.length,2);
});
for (const [label,payload] of Object.entries({missingResult:{success:true,meta:{after:null}},nullResult:{success:true,result:null,meta:{after:null}},wrongResult:{success:true,result:{},meta:{after:null}},failure:{success:false,result:[],meta:{after:null}},missingSuccess:{result:[],meta:{after:null}},missingMeta:{success:true,result:[]},missingCursor:{success:true,result:[],meta:{}},badCursor:response([],false as any),nullRow:response([null]),wrongProduct:response([{product_id:28}])})) {
  test(`${label} cannot become authoritative empty protection`,async()=>{
    await assert.rejects(getOpenOrders(27,async()=>payload),error=>error instanceof DeltaRequestError&&error.code==='DELTA_INVALID_RESPONSE');
  });
}
test('failed second page, repeated cursor, duplicate order and page cap all reject the snapshot',async()=>{
  let calls=0;
  await assert.rejects(getOpenOrders(27,async()=>{if(++calls===1)return response([order('sl')],'next');throw new DeltaRequestError('DELTA_NETWORK_TIMEOUT');}));
  await assert.rejects(getOpenOrders(27,async()=>response([],'same')));
  await assert.rejects(getOpenOrders(27,async()=>response([order('sl')],'next')));
  calls=0;await assert.rejects(getOpenOrders(27,async()=>response([],String(++calls))));assert.equal(calls,10);
});
test('malformed API snapshot through the real parser never reaches repair',async()=>{
  const h=harness();h.deps.orders=()=>getOpenOrders(27,async()=>({success:true}));await h.run();
  assert.equal(h.submissions.length,0);assert.equal(h.events.at(-1)?.code,'DELTA_INVALID_RESPONSE');
});

test('truncated order row cannot be mistaken for an empty protection snapshot',async()=>{
  const h=harness(); h.setRows([{product_id:27}]); await h.run();
  assert.equal(h.submissions.length,0); assert.equal(h.trade.protectionState,'REPAIR_REQUIRED');
  assert.equal(h.trade.exchangeSync.status,'UNVERIFIABLE');
});
