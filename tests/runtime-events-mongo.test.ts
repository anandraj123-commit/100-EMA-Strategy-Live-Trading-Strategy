import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolveModeConfig } from '../lib/app-mode';
import { getDb, closeMongoConnection } from '../lib/db/mongodb';
import { RuntimeRecorder } from '../lib/runtime-events/logger';
import { persistRuntimeWrite, runtimeEventsCollection } from '../lib/runtime-events/repository';
import { findTradeLifecycle } from '../lib/trades/repository';
const uri=process.env.TRADE_TEST_MONGODB_URI;
test('real MongoDB: atomic decision history, identity, TTL origin, indexes and permanent collection separation',{skip:!uri},async()=>{
 process.env.MONGODB_URI_TESTING=uri;process.env.MONGODB_DB_TESTING=`runtime_events_test_${randomUUID().replaceAll('-','')}`;
 (globalThis as any).appModeConfig=resolveModeConfig({...process.env});
 const db=await getDb();let time=new Date();
 const recorder=new RuntimeRecorder(persistRuntimeWrite,()=>new Date(time));
 const row:any={candleTime:1800000000,loggedAt:'2026-09-22T10:05:02Z',candle:{open:99,high:103,low:98,close:102},
  decision:{action:'WAIT',reason:'WAITING_FOR_BREAKOUT'},ema:{current:100,previous:99},buy:{patternA:true},sell:{patternA:false},
  strategyLifecycle:{signalCandleTime:1800000000,lifecycleStage:'SIGNAL_CREATED'},price:{last:102},customField:{retained:true}};
 const observation:any={kind:'decision',portfolioId:'a',symbol:'XAUTUSD',resolution:'5m',row,settings:{EMA_LENGTH:75,RR:8}};
 try{
  recorder.observe(observation);await recorder.flush();assert.equal(recorder.diagnostics.failed,0);
  const rows=await runtimeEventsCollection();let stored=(await rows.findOne({eventType:'DECISION'}))!;
  assert.deepEqual(stored.current,row);assert.equal(stored.settingsSnapshot!.EMA_LENGTH,75);assert.equal(stored.history!.length,1);
  const origin=stored.createdAt.valueOf();time=new Date(time.valueOf()+1000);row.price.last=104;
  recorder.observe(observation);recorder.observe(observation);await recorder.flush();
  stored=(await rows.findOne({eventType:'DECISION'}))!;assert.equal(stored.history!.length,1);assert.equal(stored.current!.price.last,104);
  assert.equal(stored.createdAt.valueOf(),origin);assert.equal(stored.updatedAt.valueOf(),time.valueOf());
  row.strategyLifecycle.lifecycleStage='BREAKOUT_TRIGGERED';recorder.observe(observation);await recorder.flush();
  assert.equal((await rows.findOne({eventType:'DECISION'}))!.history!.length,2);
  const restart=new RuntimeRecorder(persistRuntimeWrite,()=>new Date(time));restart.observe(observation);await restart.flush();
  assert.equal(await rows.countDocuments(),1);assert.equal((await rows.findOne({eventType:'DECISION'}))!.history!.length,2);
  // Concurrent first writes exercise the partial unique index and duplicate-key recovery.
  const peers=Array.from({length:8},()=>new RuntimeRecorder(persistRuntimeWrite));
  for(const peer of peers)peer.observe({...observation,portfolioId:'parallel'});
  await Promise.all(peers.map(peer=>peer.flush()));assert.ok(peers.every(peer=>peer.diagnostics.failed===0));
  assert.equal(await rows.countDocuments({portfolioId:'parallel'}),1);
  recorder.observe({...observation,row:{...row,candleTime:row.candleTime+300}});
  recorder.observe({...observation,symbol:'BTCUSD'});recorder.observe({...observation,portfolioId:'b'});
  recorder.observe({...observation,resolution:'1m',row:{...row,loggedAt:'2026-09-22T10:06:02Z'}});
  await recorder.flush();assert.equal(await rows.countDocuments({eventType:'DECISION'}),6);
  for(let i=0;i<20;i++)recorder.observe({kind:'event',portfolioId:'a',symbol:'XAUTUSD',event:'POSITION_RECONCILED',data:{id:String(i),at:String(i),positionSize:5}});
  recorder.observe({kind:'event',portfolioId:'a',event:'PROTECTION_REPAIRED',data:{tradeId:'t',sl:90,tp:110,slOrderId:'sl',tpOrderId:'tp'}});
  recorder.observe({kind:'event',portfolioId:'a',event:'ORDER_SENT',data:{tradeId:'t',orderId:'entry',contracts:5}});
  recorder.observe({kind:'event',portfolioId:'a',event:'TRADE_CLOSED',data:{tradeId:'t',orderId:'exit',actualExitPrice:110}});
  await recorder.flush();assert.equal(await rows.countDocuments({eventType:'SYNC'}),1);assert.equal(await rows.countDocuments({eventType:'TRADE'}),2);
  restart.observe({kind:'event',portfolioId:'a',event:'ORDER_SENT',data:{tradeId:'t',orderId:'entry',contracts:5}});await restart.flush();
  assert.equal(await rows.countDocuments({event:'ORDER_SENT'}),1);
  for(const positionSize of [4,5]){recorder.observe({kind:'event',portfolioId:'a',symbol:'XAUTUSD',event:'POSITION_RECONCILED',data:{positionSize}});await recorder.flush();}
  assert.equal(await rows.countDocuments({eventType:'SYNC'}),3,'A -> B -> A state transitions must all survive');
  restart.observe({kind:'event',portfolioId:'a',symbol:'XAUTUSD',event:'POSITION_RECONCILED',data:{positionSize:5}});await restart.flush();
  assert.equal(await rows.countDocuments({eventType:'SYNC'}),3,'restart cannot duplicate last observed state');
  const protection=(await rows.findOne({eventType:'PROTECTION'}))!;assert.equal(protection.data!.slOrderId,'sl');
  await findTradeLifecycle('none','a');const tradeIndexes=await db.collection('trades').listIndexes().toArray();
  assert.ok(tradeIndexes.every(index=>index.expireAfterSeconds===undefined));
  const indexes=await rows.listIndexes().toArray();assert.equal(indexes.find(i=>i.name==='runtime_ttl')!.expireAfterSeconds,604800);
  assert.equal(indexes.find(i=>i.name==='decision_identity')!.unique,true);
  assert.deepEqual(indexes.find(i=>i.name==='decision_identity')!.partialFilterExpression,{eventType:'DECISION'});
  await assert.rejects(rows.insertOne({...stored,_id:undefined}),{code:11000});
  await rows.insertOne({portfolioId:'a',symbol:'XAUTUSD',resolution:'5m',candleStartTime:stored.candleStartTime,eventType:'TRADE',event:'TEST_OTHER_TYPE',createdAt:time,updatedAt:time});
  recorder.observe({kind:'robot',portfolioId:'a',running:true,previous:false});
  recorder.observe({kind:'robot',portfolioId:'a',running:false,previous:true});
  recorder.observe({kind:'robot',portfolioId:'a',running:false,previous:false});
  // Synthetic redaction input only; the connection URI still comes from the environment.
  const mongoUri=new URL('mongodb://sanitizer-fixture.invalid/db');
  mongoUri.username='fixture-user';mongoUri.password='fixture-password';
  recorder.observe({kind:'event',portfolioId:'a',event:'WORKER_FAILED',data:{error:new Error('diagnostic failure'),apiKey:'never-persist',apiSecret:'never-persist',Authorization:'never-persist',mongoUri:mongoUri.href,telegramToken:'never-persist'}});
  await recorder.flush();assert.equal(await rows.countDocuments({eventType:'ROBOT'}),2);
  const error=(await rows.findOne({eventType:'ERROR'}))!;assert.doesNotMatch(JSON.stringify(error),/never-persist|fixture-user|fixture-password/);
  await closeMongoConnection();
  const reconnected=await runtimeEventsCollection();assert.equal(await reconnected.countDocuments({event:'ORDER_SENT'}),1);
  assert.equal(db.databaseName,process.env.MONGODB_DB_TESTING);assert.equal(await (await getDb()).collection('trades').countDocuments(),0);
 }finally{await (await getDb()).dropDatabase();await closeMongoConnection();}
});
