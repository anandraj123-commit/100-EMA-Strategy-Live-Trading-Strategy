import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
import * as lifecycle from '../lib/trades/lifecycle';
import * as protection from '../lib/trades/protection';
import * as statistics from '../lib/trades/statistics';
import { persistOpenBotTrade, persistOpenManualTrade, persistClosedTrade } from '../lib/trades/persistence';
import { reconcileProtection, missingProtectionEvidence } from '../lib/trades/protection-reconciliation';
import type { TradeDocument } from '../models/Trade';


// Execute the production ticker spread expressions, without a second implementation.
function quoteSpread(ticker:any,observedAt:Date){
 const source=fs.readFileSync('worker.ts','utf8'),file=ts.createSourceFile('worker.ts',source,ts.ScriptTarget.ES2022,true);
 const cycle=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='cycle') as ts.FunctionDeclaration;
 const code=cycle.body!.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>['bestBid','spread'].includes(d.name.getText(file)))).map(node=>node.getText(file)).join('\n');
 return vm.runInNewContext(ts.transpileModule(code+'\nspread;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ticker,tickerObservedAt:observedAt.toISOString(),numeric:lifecycle.finiteNumber});
}

const epoch=Date.parse('2026-09-20T10:00:00Z'),context={portfolioId:'a',environment:'demo' as const};
function repositoryFixture(){
 const rows=new Map<string,any>();
 const matches=(row:any,filter:any)=>Object.entries(filter).every(([key,value]:any)=>value&&typeof value==='object'&&'$exists'in value?(key in row)===value.$exists:row[key]===value);
 const collection={createIndex:async()=>'',findOne:async(filter:any)=>structuredClone([...rows.values()].find(row=>matches(row,filter))??null),updateOne:async(filter:any,update:any,options:any={})=>{
  const row=[...rows.values()].find(row=>matches(row,filter));
  if(row){rows.set(row.tradeId,structuredClone({...row,...update.$set}));return {matchedCount:1};}
  if(options.upsert){if(rows.has(filter.tradeId))throw Object.assign(new Error('duplicate'),{code:11000});rows.set(filter.tradeId,structuredClone(update.$setOnInsert));}
  return {matchedCount:0};
 }};
 const modules:any={'node:crypto':crypto,'./protection':protection,'./lifecycle':lifecycle,'./statistics':statistics,'../db/mongodb':{getDb:async()=>({collection:()=>collection})}};
 const restart=()=>{const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/trades/repository.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,require:(name:string)=>{assert.ok(name in modules,name);return modules[name];}});return module.exports;};
 return {rows,restart,repo:restart()};
}
const entry=(id:string,size:number,price:number,offset:number)=>({id,order_id:'entry',product_id:27,side:'buy',size,price,created_at:String((epoch+offset)*1000)});
const entries=[entry('e1',2,4369,0),entry('e2',3,4370,1),entry('e3',5,4371,2)];
const entryOrder={id:'entry',product_id:27,side:'buy',client_order_id:'ema-entry',state:'closed'};
const active:any={source:'bot',attributionStatus:'BOT_CONFIRMED',direction:'long',contracts:10,ownedContracts:10,contractValue:.1,trigger:4368.5,sl:4300,tp:4500,orderId:'entry',openedAt:epoch,entrySnapshot:{equityAtEntry:100,entryBid:4368,entryAsk:4369,entrySpreadAmount:1,entrySpreadPct:1/4368.5*100,entrySpreadTime:new Date(epoch)}};
function dependencies(repo:any,fills:any[]=entries,orders:any[]=[entryOrder]){return {upsert:repo.upsertTrade,fills:async()=>({result:fills,complete:true}),orders:async()=>({result:orders,complete:true}),now:()=>epoch+60_000} as any;}
async function seed(f=repositoryFixture(),manual=false){
 if(manual){await persistOpenManualTrade({...active,source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED'},27,'XAUTUSD',entries,dependencies(f.repo),context);}
 else await persistOpenBotTrade(active,27,'XAUTUSD',dependencies(f.repo),context);
 return {f,record:[...f.rows.values()][0] as TradeDocument};
}

for(const manual of [false,true])test(`${manual?'MANUAL':'ALGO'}: immutable initial levels, complete histories, CAS duplicate prevention, restart`,async()=>{
 const {f,record}=await seed(undefined,manual),id=record.tradeId;
 for(const sl of [4320,4340,4350,4360,4370])await Promise.all([f.repo.synchronizeTradeProtection(id,{sl},'a'),f.repo.synchronizeTradeProtection(id,{sl},'a')]);
 for(const tp of [4520,4550,4580])await f.repo.synchronizeTradeProtection(id,{tp,tpModifiedAt:new Date(epoch+100)},'a');
 for(let n=0;n<100;n++)await f.repo.synchronizeTradeProtection(id,{sl:4370+1e-10,tp:4580},'a');
 const repo=f.restart(),saved=await repo.findTradeLifecycle(id,'a');
 assert.equal(saved.initialSL,4300);assert.equal(saved.currentSL,4370);assert.equal(saved.slHistory.length,5);
 assert.equal(saved.takeProfit,4500);assert.equal(saved.currentTarget,4580);assert.equal(saved.targetHistory.length,3);
 assert.equal(saved.targetHistory[0].timeSource,'exchange');assert.equal(saved.slHistory[0].timeSource,'observed');
 assert.deepEqual(saved.slHistory.map((h:any)=>[h.previousValue,h.value]),[[4300,4320],[4320,4340],[4340,4350],[4350,4360],[4360,4370]]);
 await repo.synchronizeTradeProtection(id,{sl:999},'b');assert.equal((await repo.findTradeLifecycle(id,'a')).currentSL,4370);assert.equal(await repo.findTradeLifecycle(id,'b'),null);
});

test('OPEN upsert races reuse one lifecycle and cannot reset reconciled entry, snapshots, history or partial quantities',async()=>{
 const {f,record}=await seed();const id=record.tradeId;
 const patch=lifecycle.openExecutionPatch(record,{size:10,product_id:27,entry_price:4370.3,margin:437.03},entries,[entryOrder],true)!;
 await f.repo.mutateTradeLifecycle(id,'a',()=>({...patch,reconciledAt:new Date(epoch)}));
 await f.repo.synchronizeTradeProtection(id,{sl:4370,tp:4580},'a');
 await f.repo.mutateTradeLifecycle(id,'a',()=>({remainingContracts:6,remainingQuantity:.6}));
 await Promise.all([persistOpenBotTrade({...active,openedAt:epoch+999,entrySnapshot:{equityAtEntry:999}},27,'XAUTUSD',dependencies(f.repo),context),persistOpenBotTrade(active,27,'XAUTUSD',dependencies(f.repo),context)]);
 const saved=await f.restart().findTradeLifecycle(id,'a');
 assert.equal(f.rows.size,1);assert.equal(saved.remainingContracts,6);assert.equal(saved.actualEntryPrice,4370.3);assert.equal(saved.entryTime.valueOf(),epoch);assert.equal(saved.entryDataStatus,'reconciled');assert.equal(saved.initialSL,4300);assert.equal(saved.currentSL,4370);assert.equal(saved.equityAtEntry,100);assert.equal(saved.entryBid,4368);assert.equal(saved.slHistory.length,1);
});

test('partial entry fills are weighted and deduplicated, provisional values can become authoritative',async()=>{
 const {record}=await seed();
 const first=lifecycle.openExecutionPatch(record,{size:2},entries.slice(0,1),[{...entryOrder,state:'open'}],true)!;
 assert.equal(first.entryDataStatus,'provisional');assert.equal(first.actualEntryPrice,4369);
 const final=lifecycle.openExecutionPatch({...record,...first},{size:10},[...entries,entries[1]],[entryOrder],true)!;
 assert.equal(final.entryDataStatus,'reconciled');assert.equal(final.actualEntryPrice,4370.3);assert.deepEqual(final.entryFillIds,['e1','e2','e3']);
 assert.ok(Math.abs(final.entrySlippageAmount!-1.8)<1e-9);assert.ok(Math.abs(final.entrySlippagePct!-(1.8/4368.5*100))<1e-9);
 assert.equal(lifecycle.openExecutionPatch(record,{size:10},entries,[entryOrder],false),null);
 assert.equal(lifecycle.openExecutionPatch({...record,attributionStatus:'UNKNOWN'},{size:10},entries,[entryOrder],true),null);
 assert.throws(()=>lifecycle.uniqueFills([...entries,{...entries[0],price:1}]),/Conflicting/);
});

test('partial close remains OPEN with remaining quantity and no exit time; new additions and reversal cannot be silently owned',async()=>{
 const {record}=await seed();const exit={...entry('x1',4,4400,100),side:'sell',order_id:'exit'},order={id:'exit',product_id:27,reduce_only:true};
 const patch=lifecycle.openExecutionPatch(record,{size:6,margin:60},[...entries,exit],[entryOrder,order],true)!;
 const saved={...record,...patch};assert.equal(saved.status,'OPEN');assert.equal(saved.exitTime,null);assert.equal(saved.remainingContracts,6);assert.equal(saved.contracts,10);assert.deepEqual(saved.exitFillIds,['x1']);
 assert.equal(lifecycle.openExecutionPatch(record,{size:11},[...entries,{...entry('other',1,4400,100),order_id:'other'}],[entryOrder],true),null);
 assert.equal(lifecycle.openExecutionPatch(record,{size:-1},[...entries,{...exit,size:11}],[entryOrder,order],true),null);
});

for(const [reason,extra] of [['SL',{stop_order_type:'stop_loss_order'}],['TP',{stop_order_type:'take_profit_order'}],['MANUAL_CLOSE',{reduce_only:true}],['LIQUIDATION',{stop_order_type:'liquidation_order',reduce_only:true}],['UNKNOWN',{reduce_only:true}]] as const)test(`authoritative ${reason} full exit persists weighted fills/time once and survives restart`,async()=>{
 const {f,record}=await seed();
 const exits=[{...entry('x1',4,4400,100),side:'sell',order_id:'exit'},{...entry('x2',6,4401,200),side:'sell',order_id:reason==='UNKNOWN'?'exit2':'exit'}];
 const orders=[entryOrder,{id:'exit',product_id:27,...extra},...(reason==='UNKNOWN'?[{id:'exit2',product_id:27,stop_order_type:'take_profit_order'}]:[])];
 await f.repo.synchronizeTradeProtection(record.tradeId,{sl:4370,tp:4580},'a');
 const deps=dependencies(f.repo,[...entries,...exits,exits[0]],orders);
 const closed=await persistClosedTrade({...active,tradeId:record.tradeId},27,'XAUTUSD',99999,deps,context);
 assert.equal(closed.status,'CLOSED');assert.equal(closed.actualExitPrice,4400.6);assert.equal(closed.exitTime!.valueOf(),epoch+200);assert.equal(closed.exitReason,reason);assert.equal(closed.remainingContracts,0);assert.equal(closed.initialSL,4300);assert.equal(closed.currentSL,4370);
 await persistClosedTrade({...active,tradeId:record.tradeId},27,'XAUTUSD',1,{...deps,now:()=>epoch+999999},context);
 await persistOpenBotTrade(active,27,'XAUTUSD',deps,context);
 const restored=await f.restart().findTradeLifecycle(record.tradeId,'a');assert.equal(restored.status,'CLOSED');assert.equal(restored.exitTime.valueOf(),epoch+200);assert.equal(restored.slHistory.length,1);assert.equal(f.rows.size,1);
});

function order(leg:'sl'|'tp',price:number,size=10,id=leg as string){return {id,product_id:27,side:'sell',size,unfilled_size:size,reduce_only:true,order_type:'market_order',stop_order_type:leg==='sl'?'stop_loss_order':'take_profit_order',stop_price:String(price),stop_trigger_method:'last_traded_price',state:'pending',updated_at:new Date(epoch).toISOString()};}
async function protectionHarness(manual=false){
 const {f,record}=await seed(undefined,manual);let rows:any[]=[order('sl',4300),order('tp',4500)],history:any[]=[],fills:any[]=[],size=10,repo=f.repo;
 let trade:any;const submissions:any[]=[];let attempts=new Set<string>();let visible=true;
 const restart=async()=>{repo=f.restart();trade={tradeId:record.tradeId,source:record.source,attributionStatus:record.attributionStatus,direction:'long',contracts:10,ownedContracts:10,sl:4300,tp:4500};attempts=new Set();};await restart();
 const save=async(id:string,values:any)=>repo.synchronizeTradeProtection(id,values,'a');
 const run=()=>reconcileProtection(27,'last_traded_price',{trade:()=>trade,position:async()=>({product_id:27,size}),orders:async()=>rows,triggerPrice:async()=>4400,ownership:async()=>true,
 load:()=>repo.findTradeLifecycle(record.tradeId,'a'),persist:save,verifyMissing:async legs=>{const doc=await repo.findTradeLifecycle(record.tradeId,'a'),evidence=missingProtectionEvidence(doc,legs,history,fills,true);for(const leg of evidence.terminal){await repo.clearTerminalProtectionSubmission(doc.tradeId,'a',leg,doc.protectionSubmissions[leg].clientOrderId);attempts.delete(`${doc.tradeId}:${leg}`);}return evidence.allowed;},claim:(legs,kind)=>repo.claimProtectionSubmission(record.tradeId,'a',legs,kind),
 bracket:async(sl,tp)=>{submissions.push({sl,tp});if(visible)rows=[order('sl',sl,size,'replacement-sl'),order('tp',tp,size,'replacement-tp')];},
 stop:async(_side,quantity,leg,price,clientOrderId)=>{submissions.push({leg,price,quantity});if(visible)rows.push({...order(leg,price,quantity,'replacement-'+leg),client_order_id:clientOrderId});},
 resize:async(id,quantity)=>{submissions.push({resize:id,quantity});rows=rows.map(o=>o.id===id?{...o,size:quantity,unfilled_size:quantity}:o);},event:()=>{},repairAttempts:attempts,now:()=>epoch+1000});
 return {run,restart,submissions,record:()=>repo.findTradeLifecycle(record.tradeId,'a'),rows:(v:any[])=>{rows=v;},change:(leg:'sl'|'tp',value:number)=>{rows=rows.map(o=>o.id===leg?{...o,stop_price:String(value)}:o);},remove:(leg:'sl'|'tp',state='cancelled')=>{history.push({...rows.find(o=>o.id===leg),state});rows=rows.filter(o=>o.id!==leg);},size:(value:number)=>{size=value;},remaining:async(value:number)=>repo.mutateTradeLifecycle(record.tradeId,'a',()=>({remainingContracts:value})),visible:(value:boolean)=>{visible=value;}};
}
for(const manual of [false,true])for(const restart of [false,true])test(`${manual?'MANUAL':'ALGO'} five SL / three TP changes restore latest values, restart=${restart}, no fake history`,async()=>{
 const h=await protectionHarness(manual);await h.run();
 for(const sl of [4320,4340,4350,4360,4370]){h.change('sl',sl);await h.run();}
 for(const tp of [4520,4550,4580]){h.change('tp',tp);await h.run();}
 h.remove('sl');h.remove('tp');if(restart)await h.restart();await h.run();await h.run();
 assert.deepEqual(h.submissions,[{sl:4370,tp:4580}]);const saved=await h.record();assert.equal(saved.initialSL,4300);assert.equal(saved.currentSL,4370);assert.equal(saved.slHistory.length,5);assert.equal(saved.takeProfit,4500);assert.equal(saved.currentTarget,4580);assert.equal(saved.targetHistory.length,3);assert.equal(saved.protectionSlOrderId,'replacement-sl');assert.equal(saved.protectionTpOrderId,'replacement-tp');
});
for(const leg of ['sl','tp'] as const)test(`${leg} filled and flat is never recreated`,async()=>{const h=await protectionHarness();await h.run();h.remove(leg,'closed');h.size(0);await h.run();await h.restart();await h.run();assert.equal(h.submissions.length,0);});
test('unverified protection is not duplicated across restart',async()=>{const h=await protectionHarness();await h.run();h.remove('sl');h.visible(false);await h.run();assert.equal(h.submissions.length,1);await h.restart();await h.run();assert.equal(h.submissions.length,1);assert.equal((await h.record()).protectionSubmissions.sl.state,'PENDING');});
test('partial close resizes exact reduce-only protection IDs to remaining quantity without changing prices/history',async()=>{const h=await protectionHarness();await h.run();h.size(6);await h.remaining(6);await h.run();await h.run();assert.deepEqual(h.submissions,[{resize:'sl',quantity:6},{resize:'tp',quantity:6}]);const saved=await h.record();assert.equal(saved.status,'OPEN');assert.equal(saved.exitTime,null);assert.equal(saved.slHistory.length,0);assert.equal(saved.targetHistory.length,0);assert.equal(saved.protectionState,'ACTIVE');});
test('unreconciled triggered protection is not mistaken for cancellation',async()=>{const h=await protectionHarness();await h.run();h.remove('sl','closed');await h.run();assert.equal(h.submissions.length,0);});
test('durable repair claims serialize concurrent workers',async()=>{const {f,record}=await seed();const claimed=await Promise.all([f.repo.claimProtectionSubmission(record.tradeId,'a',['sl'],'stop'),f.repo.claimProtectionSubmission(record.tradeId,'a',['sl'],'stop')]);assert.equal(claimed.filter(Boolean).length,1);assert.equal(await f.restart().claimProtectionSubmission(record.tradeId,'a',['sl'],'stop'),null);});

test('executable quote spread, historical snapshot, signed slippage and actual margin metrics',async()=>{
 const first=quoteSpread({quotes:{best_bid:'99',best_ask:'101'},mark_price:500,close:1},new Date(epoch))!;
 const next=quoteSpread({quotes:{best_bid:'99',best_ask:'103'}},new Date(epoch+100))!;
 assert.equal(first.amount,2);assert.equal(first.pct,2);assert.equal(next.amount,4);assert.equal(quoteSpread({mark_price:1,close:2},new Date()),null);
 assert.deepEqual(lifecycle.entryExecutionMetrics('LONG',100,101,10,.1),{entrySlippagePct:1,entrySlippageAmount:1});assert.deepEqual(lifecycle.entryExecutionMetrics('SHORT',100,99,10,.1),{entrySlippagePct:1,entrySlippageAmount:1});assert.equal(lifecycle.entryExecutionMetrics('SHORT',100,101,10,.1).entrySlippageAmount,-1);assert.equal(lifecycle.entryExecutionMetrics('LONG',null,100,10,.1).entrySlippagePct,null);
 const metrics=lifecycle.exposureMetrics({size:10,mark_price:500,margin:50},.1,100);assert.equal(metrics.positionNotional,500);assert.equal(metrics.effectiveLeverage,10);assert.equal(metrics.marginUsedPct,50);assert.equal(lifecycle.exposureMetrics({size:10,mark_price:500},.1,100).effectiveLeverage,null);
 const {f,record}=await seed();await persistOpenBotTrade({...active,entrySnapshot:{equityAtEntry:999,entryBid:999,entrySpreadTime:new Date()}},27,'XAUTUSD',dependencies(f.repo),context);const saved=await f.restart().findTradeLifecycle(record.tradeId,'a');assert.equal(saved.equityAtEntry,100);assert.equal(saved.entryBid,4368);assert.equal(saved.entrySpreadTime.valueOf(),epoch);
});
test('manual trade without observed intended price has no invented slippage or entry quote',async()=>{const {record}=await seed(undefined,true);const patch=lifecycle.openExecutionPatch(record,{size:10},entries,[entryOrder],true)!;assert.equal(patch.entrySlippagePct,null);assert.equal(patch.entrySlippageAmount,null);assert.equal(record.entryBid,undefined);await assert.rejects(persistOpenManualTrade({...active,source:'exchange_existing',attributionStatus:'UNKNOWN'},27,'XAUTUSD',entries,{} as any),/MANUAL_CONFIRMED/);});

test('repair claim refuses a stale price/quantity snapshot or wrong portfolio',async()=>{
 const {f,record}=await seed();await f.repo.synchronizeTradeProtection(record.tradeId,{sl:4370},'a');
 assert.equal(await f.repo.claimProtectionSubmission(record.tradeId,'a',['sl'],'stop',{sl:4300,tp:4500,contracts:10}),null);
 assert.equal(await f.repo.claimProtectionSubmission(record.tradeId,'b',['sl'],'stop',{sl:4370,tp:4500,contracts:10}),null);
 assert.ok(await f.repo.claimProtectionSubmission(record.tradeId,'a',['sl'],'stop',{sl:4370,tp:4500,contracts:10}));
});
test('terminal entry order does not finalize lagging partial fills until full reported execution is present',async()=>{
 const {record}=await seed();const result=lifecycle.openExecutionPatch(record,{size:2},entries.slice(0,1),[{...entryOrder,size:10,unfilled_size:0}],true)!;
 assert.equal(result.entryDataStatus,'provisional');
});
test('entry cancelled after partial fill closes with actual filled quantity rather than requested quantity',async()=>{
 const {f,record}=await seed();const exit={...entry('exit-fill',2,4400,100),order_id:'exit',side:'sell'};
 const closed=await persistClosedTrade({...active,tradeId:record.tradeId},27,'XAUTUSD',null,dependencies(f.repo,[entries[0],exit],[{...entryOrder,state:'cancelled',size:10,unfilled_size:8},{id:'exit',product_id:27,reduce_only:true}]),context);
 assert.equal(closed.contracts,2);assert.equal(closed.actualEntryPrice,4369);assert.equal(closed.actualExitPrice,4400);assert.equal(closed.status,'CLOSED');
});
test('initial protection is restored unchanged when no price modification exists',async()=>{const h=await protectionHarness();await h.run();h.remove('sl');h.remove('tp');await h.restart();await h.run();assert.deepEqual(h.submissions,[{sl:4300,tp:4500}]);assert.equal((await h.record()).slHistory.length,0);assert.equal((await h.record()).targetHistory.length,0);});

test('same-side, same-size position after an unseen flat boundary is not the old owned lifecycle',async()=>{const {record}=await seed();const exit={...entry('x1',10,4400,100),side:'sell',order_id:'exit'},newEntry={...entry('new',10,4410,200),order_id:'new-order'};assert.equal(lifecycle.openExecutionPatch(record,{size:10},[...entries,exit,newEntry],[entryOrder,{id:'exit',product_id:27},{id:'new-order',product_id:27}],true),null);});

async function methodHarness(bot=false){
 const {f,record}=await seed(undefined,!bot);const id=record.tradeId;
 await f.repo.mutateTradeLifecycle(id,'a',()=>({side:'SHORT',symbol:'XAUTUSD',productId:181689,contracts:1,remainingContracts:1,initialSL:bot?4377.66:null,takeProfit:bot?4344.19:null,currentSL:bot?4377.66:null,currentTarget:bot?4344.19:null}));
 const make=(leg:'sl'|'tp',price:number,method:string,id:string)=>({...order(leg,price,1,id),product_id:181689,product_symbol:'XAUTUSD',side:'buy',stop_trigger_method:method,client_order_id:null});
 let rows:any[]=[make('sl',4377.66,bot?'last_traded_price':'mark_price','2172969019'),make('tp',4344.19,bot?'last_traded_price':'mark_price','2172969028')],size=-1,repo=f.repo,trade:any,attempts=new Set<string>(),visible=true;
 const history:any[]=[],submissions:any[]=[],events:any[]=[],priceMethods:any[]=[];
 const restart=()=>{repo=f.restart();trade={tradeId:id,source:record.source,attributionStatus:record.attributionStatus,direction:'short',contracts:1,ownedContracts:1};attempts=new Set();};restart();
 const run=()=>reconcileProtection(181689,'last_traded_price',{trade:()=>trade,load:()=>repo.findTradeLifecycle(id,'a'),position:async()=>({size,product_id:181689}),orders:async()=>rows,ownership:async()=>true,triggerPrice:async method=>{priceMethods.push(method);return method==='mark_price'?4369.74:method==='spot_price'?4368:4370;},persist:(id,values)=>repo.synchronizeTradeProtection(id,values,'a'),
 verifyMissing:async legs=>missingProtectionEvidence(await repo.findTradeLifecycle(id,'a'),legs,history,[],true).allowed,
 claim:(legs,kind)=>repo.claimProtectionSubmission(id,'a',legs,kind),
 bracket:async(sl,tp,method)=>{submissions.push({sl,tp,method});if(visible)rows=[make('sl',sl,method!,'repaired-sl'),make('tp',tp,method!,'repaired-tp')];},
 stop:async(_side,quantity,leg,price,clientOrderId,method)=>{submissions.push({leg,price,quantity,method});if(visible)rows.push({...make(leg,price,method!,'repaired-'+leg),size:quantity,unfilled_size:quantity,client_order_id:clientOrderId});},
 resize:async(orderId,quantity)=>{submissions.push({resize:orderId,quantity});rows=rows.map(row=>row.id===orderId?{...row,size:quantity,unfilled_size:quantity}:row);},event:(type,detail)=>events.push({type,...detail}),repairAttempts:attempts,now:()=>epoch});
 return {run,restart,submissions,events,priceMethods,record:()=>repo.findTradeLifecycle(id,'a'),trade:()=>trade,visible:(value:boolean)=>{visible=value;},size:(value:number)=>{size=value;},patch:(value:any)=>repo.mutateTradeLifecycle(id,'a',()=>value),
 change:(leg:'sl'|'tp',values:any)=>{rows=rows.map(row=>row.stop_order_type===(leg==='sl'?'stop_loss_order':'take_profit_order')?{...row,...values}:row);},
 remove:(leg:'sl'|'tp')=>{const kind=leg==='sl'?'stop_loss_order':'take_profit_order';history.push({...rows.find(row=>row.stop_order_type===kind),state:'cancelled'});rows=rows.filter(row=>row.stop_order_type!==kind);},
 rows:(value:any[])=>{rows=value;}};
}
test('audited MANUAL SHORT first discovery accepts mark methods despite last strategy source; initial/current values and IDs persist without history',async()=>{
 const h=await methodHarness();await h.run();for(let n=0;n<100;n++)await h.run();const r=await h.record();
 assert.equal(h.trade().protectionState,'ACTIVE');assert.equal(r.initialSL,4377.66);assert.equal(r.currentSL,4377.66);assert.equal(r.takeProfit,4344.19);assert.equal(r.currentTarget,4344.19);assert.equal(r.currentSLTriggerMethod,'mark_price');assert.equal(r.currentTargetTriggerMethod,'mark_price');assert.equal(r.protectionSlOrderId,'2172969019');assert.equal(r.protectionTpOrderId,'2172969028');assert.equal(r.slHistory.length,0);assert.equal(r.targetHistory.length,0);assert.equal(h.submissions.length,0);assert.ok(h.priceMethods.every(method=>method==='mark_price'));
});
for(const bot of [false,true])test(`${bot?'ALGO':'MANUAL'} external price/method replacement persists and restart repair uses latest independent methods`,async()=>{
 const h=await methodHarness(bot);await h.run();h.change('sl',{stop_price:'4375',stop_trigger_method:'mark_price',id:'replacement-sl'});h.change('tp',{stop_price:'4340',stop_trigger_method:'spot_price',id:'replacement-tp'});await h.run();await h.run();
 let r=await h.record();assert.equal(r.initialSL,4377.66);assert.equal(r.currentSL,4375);assert.equal(r.takeProfit,4344.19);assert.equal(r.currentTarget,4340);assert.equal(r.slHistory.length,1);assert.equal(r.targetHistory.length,1);assert.equal(r.currentSLTriggerMethod,'mark_price');assert.equal(r.currentTargetTriggerMethod,'spot_price');
 h.remove('sl');h.remove('tp');h.restart();await h.run();await h.run();await h.run();
 assert.deepEqual(h.submissions,[{leg:'sl',price:4375,quantity:1,method:'mark_price'},{leg:'tp',price:4340,quantity:1,method:'spot_price'}]);r=await h.record();assert.equal(r.slHistory.length,1);assert.equal(r.targetHistory.length,1);assert.equal(r.currentSLTriggerMethod,'mark_price');assert.equal(r.currentTargetTriggerMethod,'spot_price');assert.equal(r.protectionState,'ACTIVE');
});
for(const leg of ['sl','tp'] as const)test(`${leg} method-only change persists without price history; repeated reads do not reset it`,async()=>{const h=await methodHarness(true);await h.run();h.change(leg,{stop_trigger_method:'mark_price'});await h.run();h.restart();await h.run();const r=await h.record();assert.equal(r[leg==='sl'?'currentSLTriggerMethod':'currentTargetTriggerMethod'],'mark_price');assert.equal(r.slHistory.length,0);assert.equal(r.targetHistory.length,0);assert.equal(h.submissions.length,0);});
for(const [field,value] of Object.entries({stop_trigger_method:'unknown',product_id:999,product_symbol:'BTCUSD',side:'sell',reduce_only:false,size:2,order_type:'limit_order',state:'closed',client_order_id:123}))test(`manual discovery rejects ${field}=${value}`,async()=>{const h=await methodHarness();h.change('sl',{[field]:value});await h.run();const r=await h.record();assert.equal(r.currentSL,null);assert.equal(h.submissions.length,0);});
for(const attributionStatus of ['UNKNOWN','LOOKUP_FAILED'])test(`protection cannot claim ${attributionStatus} ownership`,async()=>{const h=await methodHarness();h.trade().attributionStatus=attributionStatus;await h.run();assert.equal((await h.record()).currentSL,null);assert.equal(h.submissions.length,0);});
for(const leg of ['sl','tp'] as const)test(`mark-triggered ${leg} disappearance after position flat never submits protection`,async()=>{const h=await methodHarness();await h.run();h.remove(leg);h.size(0);await h.run();h.restart();await h.run();assert.equal(h.submissions.length,0);});
test('pending mark-method repair remains unverified and cannot be duplicated after restart',async()=>{const h=await methodHarness();await h.run();h.remove('sl');h.visible(false);await h.run();h.restart();for(let n=0;n<5;n++)await h.run();assert.equal(h.submissions.length,1);assert.equal((await h.record()).protectionSubmissions.sl.state,'PENDING');});
test('partial close safely resizes exact protection IDs while preserving independent methods',async()=>{const h=await methodHarness(true);await h.patch({contracts:10,remainingContracts:10});h.trade().contracts=10;h.trade().ownedContracts=10;h.size(-10);h.change('sl',{size:10,unfilled_size:10,stop_trigger_method:'mark_price'});h.change('tp',{size:10,unfilled_size:10,stop_trigger_method:'spot_price'});await h.run();h.size(-6);await h.patch({remainingContracts:6});await h.run();await h.run();const r=await h.record();assert.equal(r.status,'OPEN');assert.equal(r.currentSLTriggerMethod,'mark_price');assert.equal(r.currentTargetTriggerMethod,'spot_price');assert.equal(r.slHistory.length,0);assert.deepEqual(h.submissions,[{resize:'2172969019',quantity:6},{resize:'2172969028',quantity:6}]);});
