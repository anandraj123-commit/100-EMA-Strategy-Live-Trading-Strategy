import assert from 'node:assert/strict';
import test from 'node:test';
import { hasActivePortfolioTrades } from '../lib/trades/repository';
import { resolveHistoricalPortfolioId } from '../lib/portfolio/access';
import { finalPreOrderSafetyCheck } from '../lib/runtime/final-preorder';
import { ObjectId } from 'mongodb';
import { EventEmitter } from 'node:events';
import { deletePortfolioCoordinated,verifyPortfolioDeletion,findDeletionBlockingIntent } from '../lib/portfolio/deletion';
import { readPortfolioDeletion,portfolioEntryAllowed,waitForPortfolioStopped } from '../lib/portfolio/deletion-state';
import { deletePortfolio,insertPortfolio } from '../lib/portfolio/repository';
import { runtimeSettingDefaults } from '../lib/settings/definitions';
import { acquireLease,portfolioEntryLeaseKey,releaseLease } from '../lib/runtime/leases';
import { TradingRuntimeManager } from '../lib/runtime/manager';

function matches(row:any,q:any):boolean{return Object.entries(q).every(([k,v]:any)=>k==='$or'?v.some((x:any)=>matches(row,x)):v&&typeof v==='object'&&!(v instanceof ObjectId)&&!(v instanceof Date)?Object.entries(v).every(([op,n]:any)=>op==='$ne'?row[k]!==n:op==='$gt'?row[k]>n:op==='$lte'?row[k]<=n:op==='$in'?n.includes(row[k]):false):String(row[k])===String(v));}
function fixture(){
  const data=new Map<string,Map<string,any>>(),events:string[]=[];let failure='';
  const table=(name:string)=>{if(!data.has(name))data.set(name,new Map());return data.get(name)!;};
  const db={collection(name:string){const rows=table(name);return {
    createIndex:async()=>'',findOne:async(q:any)=>[...rows.values()].find(r=>matches(r,q))??null,
    updateOne:async(q:any,u:any,options:any={})=>{let row=[...rows.values()].find(r=>matches(r,q));if(!row&&!options.upsert)return {modifiedCount:0};if(!row){row={...q,...u.$setOnInsert};rows.set(String(q._id),row);}Object.assign(row,u.$set);return {modifiedCount:1};},
    findOneAndUpdate:async(q:any,u:any)=>{let row=rows.get(String(q._id));if(row&&!matches(row,q))throw Object.assign(new Error('duplicate'),{code:11000});row={_id:q._id,...row,...u.$set};rows.set(String(q._id),row);return row;},
    insertOne:async(row:any)=>{rows.set(String(row._id),row);return {insertedId:row._id};},
    deleteOne:async(q:any)=>{if(failure===name){failure='';throw new Error('injected write failure');}const row=[...rows.values()].find(r=>matches(r,q));events.push(`delete:${name}:${String(q._id)}`);return {deletedCount:row&&rows.delete(String(row._id))?1:0};}
  };}};
  (globalThis as any).mongoClientPromise=Promise.resolve({db:()=>db});
  const row=(id=new ObjectId())=>({_id:id,symbol:'XAUTUSD',productId:27,environment:'demo' as const,name:null,contractValue:1,settlingAsset:'USD',underlyingAsset:'XAUT',createdAt:new Date(),updatedAt:new Date()});
  const p1=row(),p2=row();for(const p of [p1,p2]){table('portfolio').set(String(p._id),p);table('runtime_settings').set(`portfolio:${p._id}`,{_id:`portfolio:${p._id}`,values:{RR:99}});}
  table('runtime_settings').set('runtime-settings',{_id:'runtime-settings',values:{RR:77}});
  for(const name of ['trades','entry_intents','trade_fill_claims','daily_loss_streaks'])table(name).set('history',{_id:'history',portfolioId:String(p1._id),status:'CLOSED',state:'CONFIRMED',ownershipPersistedAt:new Date()});
  const verification={status:()=>({position:{size:0}}),activity:()=>({}),position:async()=>({size:0}),openOrders:async()=>[]};
  const verify=(p:any)=>verifyPortfolioDeletion(p,{...verification,hasActiveTrades:hasActivePortfolioTrades,blockingIntent:findDeletionBlockingIntent});
  const remove=(p=p1,extra:any={})=>deletePortfolioCoordinated(p,deletePortfolio,{verify,stopped:async id=>{assert.equal(await portfolioEntryAllowed(id),false);events.push(`stopped:${id}`);return true;},...extra});
  return {p1,p2,table,events,remove,verify,verification,fail:(name:string)=>failure=name};
}

test('safe portfolio deletion behavioral coverage',async t=>{
  for(const source of ['BOT_CONFIRMED','MANUAL_CONFIRMED'])for(const status of ['OPEN','RECONCILING','FAILED','ACTIVE','PENDING_PROTECTION','REPAIR_REQUIRED'])await t.test(`${source} ${status} blocks deletion without configuration removal`,async()=>{
    const f=fixture(),id=String(f.p1._id);f.table('trades').set('active',{_id:'active',portfolioId:id,attributionStatus:source,status});
    assert.deepEqual(await f.remove(),{ok:false,reason:'ACTIVE'});assert.ok(f.table('portfolio').has(id));assert.ok(f.table('runtime_settings').has(`portfolio:${id}`));assert.deepEqual(f.events.filter(event=>!event.startsWith('delete:runtime_locks:')),[]);assert.equal(await readPortfolioDeletion(id),null);assert.ok(f.table('trades').has('active'));
  });
  await t.test('flat deletion preserves history and identical-symbol neighbor; recreation uses fresh defaults',async()=>{
    const f=fixture(),id=String(f.p1._id),other=String(f.p2._id);const history=structuredClone([...f.table('trades').values()]);
    f.table('runtime_locks').set(`portfolio-runtime:${other}`,{_id:`portfolio-runtime:${other}`,ownerId:'neighbor'});
    assert.deepEqual(await f.remove(),{ok:true});assert.ok(!f.table('portfolio').has(id));assert.ok(!f.table('runtime_settings').has(`portfolio:${id}`));assert.ok(f.table('portfolio').has(other));assert.ok(f.table('runtime_settings').has(`portfolio:${other}`));assert.ok(f.table('runtime_settings').has('runtime-settings'));assert.ok(f.table('runtime_locks').has(`portfolio-runtime:${other}`));
    assert.deepEqual([...f.table('trades').values()],history);for(const name of ['entry_intents','trade_fill_claims','daily_loss_streaks'])assert.equal(f.table(name).get('history').portfolioId,id);
    assert.ok(f.events.indexOf(`stopped:${id}`)<f.events.indexOf(`delete:portfolio:${id}`));
    const {_id,...config}=f.p1,newPortfolio=await insertPortfolio(config);assert.notEqual(String(newPortfolio._id),id);assert.deepEqual(f.table('runtime_settings').get(`portfolio:${newPortfolio._id}`).values,runtimeSettingDefaults());assert.equal(await portfolioEntryAllowed(id),false);assert.equal(String((await resolveHistoricalPortfolioId(id))?._id),id);
  });
  for(const failed of ['portfolio','runtime_settings'])await t.test(`retry after ${failed} failure`,async()=>{
    const f=fixture(),id=String(f.p1._id);f.fail(failed);assert.deepEqual(await f.remove(),{ok:false,reason:'CLEANUP_FAILED'});const marker=await readPortfolioDeletion(id);assert.equal(marker?.state,'deleting');assert.equal(await portfolioEntryAllowed(id),false);
    assert.deepEqual(await f.remove(marker!.portfolio as any),{ok:true});assert.deepEqual(await f.remove(),{ok:true});assert.ok(!f.table('portfolio').has(id));assert.ok(!f.table('runtime_settings').has(`portfolio:${id}`));assert.equal(f.table('trades').get('history').portfolioId,id);
  });
  await t.test('concurrent delete and entry cannot acquire deletion lease; tombstone blocks later entries',async()=>{
    const f=fixture(),id=String(f.p1._id);let resume!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),pause=new Promise<void>(r=>resume=r);
    const first=f.remove(f.p1,{stopped:async()=>{started();await pause;return true;}});await ready;
    assert.deepEqual(await f.remove(),{ok:false,reason:'IN_PROGRESS'});assert.equal(await acquireLease(portfolioEntryLeaseKey(id),'entry',30_000),null);assert.equal(await portfolioEntryAllowed(id),false);resume();assert.deepEqual(await first,{ok:true});assert.equal(await portfolioEntryAllowed(id),false);
    const other=await acquireLease(portfolioEntryLeaseKey(String(f.p2._id)),'other-entry',30_000);assert.ok(other);await releaseLease(other!);
  });
  await t.test('entry already preparing blocks delete before marker or destructive work',async()=>{const f=fixture(),lease=await acquireLease(portfolioEntryLeaseKey(String(f.p1._id)),'entry',30_000);assert.deepEqual(await f.remove(),{ok:false,reason:'IN_PROGRESS'});assert.deepEqual(f.events.filter(event=>!event.startsWith('delete:runtime_locks:')),[]);await releaseLease(lease!);});
  await t.test('stop timeout retains config and durable entry block',async()=>{const f=fixture();assert.deepEqual(await f.remove(f.p1,{stopped:async()=>false}),{ok:false,reason:'STOP_FAILED'});assert.equal(f.table('portfolio').size,2);assert.equal(f.table('runtime_settings').size,3);assert.equal(await portfolioEntryAllowed(String(f.p1._id)),false);});
  await t.test('unknown exchange state fails closed',async()=>{for(const position of [null,{}, {size:'invalid'}]){const f=fixture();assert.deepEqual(await f.remove(f.p1,{verify:(p:any)=>verifyPortfolioDeletion(p,{...f.verification,hasActiveTrades:async()=>false,blockingIntent:async()=>null,position:async()=>position})}),{ok:false,reason:'VERIFICATION_FAILED'});assert.deepEqual(f.events.filter(event=>!event.startsWith('delete:runtime_locks:')),[]);}});
  await t.test('expired runtime lease is not shutdown confirmation',async()=>{const f=fixture(),id=String(f.p1._id);f.table('runtime_locks').set(`portfolio-runtime:${id}`,{_id:`portfolio-runtime:${id}`,expiresAt:new Date(0)});assert.equal(await waitForPortfolioStopped(id,1),false);});
  await t.test('manager keeps worker tracked until actual exit, stops exact ID and never respawns deleting portfolio',async()=>{
    const f=fixture(),children=new Map<string,any>(),released:string[]=[];let deleting=false;
    const manager=new TradingRuntimeManager(async()=>[f.p1,f.p2],p=>{const child=new EventEmitter() as any;child.kill=()=>{child.stopped=true;return true;};children.set(String(p._id),child);return child;},{allowed:async id=>!deleting||id!==String(f.p1._id),acquire:async(id,ownerId)=>({key:id,ownerId,acquiredAt:new Date(),expiresAt:new Date(Date.now()+30_000)}),release:async l=>{released.push(l.key);}});
    await manager.synchronize();deleting=true;await manager.synchronize();assert.equal(manager.instances.size,2);assert.equal(released.length,0);assert.equal(children.get(String(f.p1._id)).stopped,true);assert.equal(children.get(String(f.p2._id)).stopped,undefined);children.get(String(f.p1._id)).emit('exit',0,null);await manager.synchronize();assert.equal(manager.instances.size,1);assert.deepEqual(released,[String(f.p1._id)]);
  });
  await t.test('confirmed entry with missing persisted ownership blocks deletion',async()=>{
    const f=fixture();f.table('entry_intents').set('uncertain',{_id:'uncertain',portfolioId:String(f.p1._id),state:'CONFIRMED',ownershipPersistedAt:null});
    assert.deepEqual(await f.remove(),{ok:false,reason:'ENTRY_UNRESOLVED'});assert.deepEqual(f.events.filter(event=>!event.startsWith('delete:runtime_locks:')),[]);
  });
  await t.test('persisted-state lookup failure preserves configuration',async()=>{
    const f=fixture();assert.deepEqual(await f.remove(f.p1,{verify:async()=>{throw new Error('DB unavailable');}}),{ok:false,reason:'VERIFICATION_FAILED'});assert.deepEqual(f.events.filter(event=>!event.startsWith('delete:runtime_locks:')),[]);
  });
  await t.test('final entry barrier observes durable deletion and submits zero orders',async()=>{
    const f=fixture(),id=String(f.p1._id);await f.remove();let orders=0;
    const setup={direction:'long' as const,trigger:100,sl:90,candleTime:1000,configRevision:'r'};
    const config={revision:'r',autoTrade:true,entryValidCandles:2,resolutionSec:60,riskPct:1,rr:8,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:20,gstPct:18};
    const checked=await finalPreOrderSafetyCheck({identity:{portfolioId:id,environment:'demo',symbol:'XAUTUSD',productId:27},setup,config,product:{id:27,contractValue:0.01,tickSize:0.5,takerRate:0.0005}},{robotRunning:()=>true,refreshConfig:async()=>config,currentPending:()=>setup,latestCompletedCandleTime:()=>1060,leaseOwned:async()=>true,leaseLost:()=>false,portfolioEntryAllowed:()=>portfolioEntryAllowed(id),portfolio:async()=>null,position:async()=>({size:0}),availableMargin:async()=>1000});
    if(checked.ok)orders++;
    assert.deepEqual(checked,{ok:false,reason:'FINAL_PREORDER_DELETION_IN_PROGRESS'});assert.equal(orders,0);
  });
  await t.test('active trade discovered after stop preserves all configuration',async()=>{
    const f=fixture(),id=String(f.p1._id);
    const result=await f.remove(f.p1,{stopped:async()=>{f.table('trades').set('late',{_id:'late',portfolioId:id,status:'OPEN'});return true;}});
    assert.deepEqual(result,{ok:false,reason:'ACTIVE'});assert.ok(f.table('portfolio').has(id));assert.ok(f.table('runtime_settings').has(`portfolio:${id}`));
  });
  await t.test('lost deletion lease prevents destructive cleanup',async()=>{
    const f=fixture();let checks=0;
    assert.deepEqual(await f.remove(f.p1,{owns:async()=>++checks===1}),{ok:false,reason:'IN_PROGRESS'});
    assert.equal(f.table('portfolio').size,2);assert.equal(f.table('runtime_settings').size,3);
  });
  delete (globalThis as any).mongoClientPromise;
});
