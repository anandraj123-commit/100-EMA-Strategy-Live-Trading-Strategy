import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { resolveModeConfig } from '../lib/app-mode';
import { getDb, closeMongoConnection } from '../lib/db/mongodb';
import { persistOpenBotTrade, persistOpenManualTrade, reconcileOpenTradeExecution, persistClosedTrade } from '../lib/trades/persistence';
import { findTradeLifecycle, findUnresolvedBotTrades, synchronizeTradeProtection, claimProtectionSubmission } from '../lib/trades/repository';

const uri=process.env.TRADE_TEST_MONGODB_URI;
test('real MongoDB lifecycle CAS, fill claims, partial entry/close, restart and portfolio isolation',{skip:!uri},async()=>{
 process.env.MONGODB_URI_TESTING=uri;process.env.MONGODB_DB_TESTING=`active_trade_test_${crypto.randomBytes(8).toString('hex')}`;
 (globalThis as any).appModeConfig=resolveModeConfig({...process.env});
 const originalFetch=global.fetch,db=await getDb(),epoch=Date.parse('2026-09-20T10:00:00Z'),context={portfolioId:'a',environment:'demo' as const};
 const entry=(id:string,size:number,price:number,offset:number)=>({id,order_id:'entry',product_id:27,side:'buy',size,price,commission:'.01',created_at:String((epoch+offset)*1000)});
 const entries=[entry('e1',2,4369,0),entry('e2',3,4370,1),entry('e3',5,4371,2)];let fills:any[]=[entries[0]],orders:any[]=[{id:'entry',product_id:27,side:'buy',state:'open',client_order_id:'ema-entry'}];
 global.fetch=async(input,init)=>{assert.equal(init?.method??'GET','GET');const url=new URL(String(input));assert.equal(url.searchParams.get('product_ids'),'27');assert.ok(url.pathname==='/v2/fills'||url.pathname==='/v2/orders/history');return new Response(JSON.stringify({success:true,result:url.pathname==='/v2/fills'?fills:orders,meta:{after:null}}));};
 try{
  const active:any={source:'bot',attributionStatus:'BOT_CONFIRMED',direction:'long',trigger:4368.5,sl:4300,tp:4500,contracts:10,ownedContracts:10,contractValue:.1,orderId:'entry',openedAt:epoch,entrySnapshot:{equityAtEntry:100,entryBid:4368,entryAsk:4369,entrySpreadAmount:1,entrySpreadPct:1/4368.5*100,entrySpreadTime:new Date(epoch)}};
  const saved=await persistOpenBotTrade(active,27,'XAUTUSD',undefined,context);active.tradeId=saved!.tradeId;
  let reconciled=await reconcileOpenTradeExecution(active,27,{size:2,entry_price:4369},context);assert.equal(reconciled!.entryDataStatus,'provisional');
  fills=entries;orders[0].state='closed';orders[0].size=10;orders[0].unfilled_size=0;
  reconciled=await reconcileOpenTradeExecution(active,27,{size:10,entry_price:4370.3},context,{product_id:27,size:10,entry_price:4370.3,mark_price:4370.3,margin:43.703});
  assert.equal(reconciled!.actualEntryPrice,4370.3);assert.equal(reconciled!.entryDataStatus,'reconciled');assert.equal(reconciled!.effectiveLeverage,100);assert.equal(reconciled!.marginUsedPct,43.703);assert.equal(reconciled!.entryTime!.valueOf(),epoch);
  for(const sl of [4320,4340,4350,4360,4370])await Promise.all([synchronizeTradeProtection(active.tradeId,{sl,slTriggerMethod:'mark_price'},'a'),synchronizeTradeProtection(active.tradeId,{sl,slTriggerMethod:'mark_price'},'a')]);
  for(const tp of [4520,4550,4580])await synchronizeTradeProtection(active.tradeId,{tp,tpTriggerMethod:'spot_price'},'a');
  const exit1={...entry('x1',4,4400,100),side:'sell',order_id:'exit'};fills=[...entries,exit1];orders.push({id:'exit',product_id:27,reduce_only:true,state:'open'});
  reconciled=await reconcileOpenTradeExecution(active,27,{size:6,entry_price:4370.3},context);
  assert.equal(reconciled!.remainingContracts,6);assert.equal(reconciled!.status,'OPEN');assert.equal(reconciled!.exitTime,null);
  await reconcileOpenTradeExecution(active,27,{size:6,entry_price:4370.3},context);assert.equal(await db.collection('trade_fill_claims').countDocuments(),4);
  const claims=await Promise.all([claimProtectionSubmission(active.tradeId,'a',['sl'],'stop'),claimProtectionSubmission(active.tradeId,'a',['sl'],'stop')]);assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await findTradeLifecycle(active.tradeId,'b'),null);assert.equal(await reconcileOpenTradeExecution(active,27,{size:6}, {...context,portfolioId:'b'}),null);assert.equal(await reconcileOpenTradeExecution(active,27,{size:6},{...context,environment:'real'}),null);
  await closeMongoConnection();const restored=await findTradeLifecycle(active.tradeId,'a');assert.equal(restored!.currentSLTriggerMethod,'mark_price');assert.equal(restored!.currentTargetTriggerMethod,'spot_price');assert.equal(restored!.initialSL,4300);assert.equal(restored!.currentSL,4370);assert.equal(restored!.slHistory!.length,5);assert.equal(restored!.currentTarget,4580);assert.equal(restored!.targetHistory!.length,3);assert.equal(restored!.entrySpreadTime!.valueOf(),epoch);assert.equal(restored!.entryTime!.valueOf(),epoch);assert.equal(await claimProtectionSubmission(active.tradeId,'a',['sl'],'stop'),null);
  const historyFetch=global.fetch;global.fetch=async()=>{throw new Error('temporary history outage');};
  await assert.rejects(persistClosedTrade({...active,positionClosedAt:epoch+1500},27,'XAUTUSD',null,undefined,context));
  global.fetch=historyFetch;
  const awaitingHistory=await findTradeLifecycle(active.tradeId,'a');assert.equal(awaitingHistory!.status,'CLOSED');assert.equal(awaitingHistory!.remainingContracts,0);assert.equal(awaitingHistory!.exitTimeSource,'observed');assert.equal(awaitingHistory!.exitTime!.valueOf(),epoch+1500);assert.equal(awaitingHistory!.actualExitPrice,null);assert.equal(awaitingHistory!.closeReconciliationPending,true);
  assert.equal((await findUnresolvedBotTrades(27,'a')).length,1);
  fills.push({...entry('x2',6,4401,200),side:'sell',order_id:'exit'});orders[1].state='closed';
  const closed=await persistClosedTrade(active,27,'XAUTUSD',99999,undefined,context);assert.equal(closed.currentSLTriggerMethod,'mark_price');assert.equal(closed.currentTargetTriggerMethod,'spot_price');assert.equal(closed.status,'CLOSED');assert.equal(closed.closeReconciliationPending,false);assert.equal(closed.exitTimeSource,'exchange');assert.equal(closed.actualExitPrice,4400.6);assert.equal(closed.exitTime!.valueOf(),epoch+200);assert.equal(closed.slHistory!.length,5);assert.equal(closed.targetHistory!.length,3);
  await persistClosedTrade(active,27,'XAUTUSD',0,undefined,context);assert.equal((await findTradeLifecycle(active.tradeId,'a'))!.exitTime!.valueOf(),epoch+200);
  const db2=await getDb();assert.equal(await db2.collection('trades').countDocuments(),1);assert.equal(await db2.collection('trade_fill_claims').countDocuments(),5);
  // Manual partial entry gains fills under the SAME known entry order/lifecycle.
  const manualFills=entries.map(f=>({...f,id:'m'+f.id,order_id:'manual-entry'}));
  const manual:any={...active,source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED',orderId:'manual-entry',contracts:2,ownedContracts:2};
  const m1=await persistOpenManualTrade(manual,27,'XAUTUSD',manualFills.slice(0,1),undefined,context);
  const m2=await persistOpenManualTrade({...manual,contracts:10,ownedContracts:10},27,'XAUTUSD',manualFills,undefined,context);assert.equal(m1.tradeId,m2.tradeId);
  await Promise.all([persistOpenManualTrade({...manual,contracts:10,ownedContracts:10},27,'XAUTUSD',manualFills,undefined,context),persistOpenManualTrade({...manual,contracts:10,ownedContracts:10},27,'XAUTUSD',manualFills,undefined,context)]);
  assert.equal(await db2.collection('trades').countDocuments(),2);
  const manualExits=[{...manualFills[0],id:'mx1',order_id:'manual-exit',side:'sell',size:10,price:4400,created_at:String((epoch+1000)*1000)}];
  fills=[...manualFills,...manualExits];orders=[{id:'manual-entry',product_id:27,state:'closed',side:'buy'},{id:'manual-exit',product_id:27,state:'closed',side:'sell'}];
  const manualClosed=await persistClosedTrade({...manual,tradeId:m1.tradeId,entryFillIds:manualFills.map(f=>f.id),contracts:10,ownedContracts:10},27,'XAUTUSD',null,undefined,context);assert.equal(manualClosed.exitTime!.valueOf(),epoch+1000);assert.equal(manualClosed.actualExitPrice,4400);assert.equal(manualClosed.entrySlippagePct,null);
 }finally{global.fetch=originalFetch;await (await getDb()).dropDatabase();await closeMongoConnection();}
});
