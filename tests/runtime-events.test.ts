import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { RuntimeRecorder, decisionState } from '../lib/runtime-events/logger';
import { sanitize } from '../lib/runtime-events/sanitizer';
import { runtimeEventIndexes, type RuntimeWrite } from '../lib/runtime-events/repository';
import { workerHarness } from './strategy-regression/worker-harness';

const sample=()=>({candleTime:1200,loggedAt:'2026-09-22T10:05:02Z',candle:{open:99,high:103,low:98,close:102},
  ema:{current:100,previous:99,direction:'UP'},buy:{slope:true,patternA:true,patternB:false,setup:true},
  sell:{slope:false,patternA:false,patternB:false,setup:false},decision:{action:'WAIT',reason:'WAITING_FOR_BREAKOUT'},
  strategyLifecycle:{signalCandleTime:1200,pendingExists:true,lifecycleStage:'SIGNAL_CREATED',breakoutPrice:103},
  runtimeObservation:{positionOpen:false,robotRunning:true,autoTrade:true,newEntryAllowed:true,currentPrice:102,observedAt:'2026-09-22T10:05:02Z'},
  customUsefulField:{preserved:true},price:{mark:101,last:102}});
const decision=(row=sample(),portfolioId='a',symbol='XAUTUSD')=>({kind:'decision' as const,portfolioId,symbol,resolution:'5m',settings:{EMA_LENGTH:75,RR:8},row});

test('complete decision snapshots and original settings are captured without mutating runtime objects',async()=>{
 const writes:RuntimeWrite[]=[],recorder=new RuntimeRecorder(async w=>{writes.push(w);});
 const row=sample();recorder.observe(decision(row));row.candle.close=999;await recorder.flush();
 const set=(writes[0].update as any[])[0].$set;
 assert.equal(set.current.$literal.candle.close,102);assert.equal(set.current.$literal.customUsefulField.preserved,true);
 assert.equal(set.settingsSnapshot.$ifNull[1].$literal.EMA_LENGTH,75);
 assert.equal(set.current.$literal.loggedAt,'2026-09-22T10:05:02Z');
 assert.equal(writes[0].filter.candleStartTime.valueOf(),1200000);
 assert.ok(set.createdAt.$ifNull);assert.ok(set.updatedAt.$literal instanceof Date);
});

test('history projection ignores only live/ticker refreshes and retains meaningful transitions',()=>{
 const first=sample(),next=structuredClone(first);next.runtimeObservation.currentPrice=900;next.price.mark=800;next.price.last=700;
 next.runtimeObservation.observedAt='later';next.strategyLifecycle.breakoutPrice=901;
 assert.deepEqual(decisionState(first),decisionState(next));
 next.strategyLifecycle.lifecycleStage='BREAKOUT_TRIGGERED';assert.notDeepEqual(decisionState(first),decisionState(next));
});

test('bounded asynchronous queue coalesces price updates, preserves transitions and isolates hanging/failing writes',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const recorder=new RuntimeRecorder(async()=>{await gate;throw new Error('database unavailable');},()=>new Date(),2);
 for(let i=0;i<20;i++){const row=sample();row.price.last=i;recorder.observe(decision(row));}
 assert.equal(recorder.diagnostics.dropped,0);
 const draining=recorder.flush();
 for(let i=0;i<20;i++)recorder.observe({kind:'event',portfolioId:'a',event:'ORDER_SENT',data:{orderId:String(i)}});
 assert.ok(recorder.diagnostics.dropped>0);release();await draining;assert.ok(recorder.diagnostics.failed>0);
 recorder.observe(decision());await recorder.flush();assert.ok(recorder.diagnostics.failed>1);
});

test('event categories, portfolio isolation, authoritative idempotency, sync noise and error rate limits',async()=>{
 const writes:RuntimeWrite[]=[],recorder=new RuntimeRecorder(async w=>{writes.push(w);},()=>new Date('2026-09-22T10:00:00Z'));
 for(const portfolioId of ['a','b'])for(let i=0;i<10;i++){
  recorder.observe({kind:'event',portfolioId,event:'POSITION_RECONCILED',data:{id:String(i),at:String(i),tradeId:'trade',positionSize:5}});
  recorder.observe({kind:'event',portfolioId,event:'PROTECTION_REPAIRED',data:{tradeId:'trade',sl:90,tp:110}});
  recorder.observe({kind:'event',portfolioId,event:'WORKER_FAILED',data:{error:new Error('failure')}});
 }
 await recorder.flush();assert.equal(writes.length,6);
 assert.deepEqual(new Set(writes.map(w=>(w.update as any).$setOnInsert.eventType)),new Set(['SYNC','PROTECTION','ERROR']));
 assert.deepEqual(new Set(writes.map(w=>w.filter.portfolioId)),new Set(['a','b']));
});

test('trade changes remain separate; duplicate durable snapshots do not repeat; unrelated portfolio rejected',async()=>{
 const writes:RuntimeWrite[]=[],recorder=new RuntimeRecorder(async w=>{writes.push(w);});
 const record={portfolioId:'a',tradeId:'trade',entryFillIds:['f1'],status:'OPEN',actualEntryPrice:101};
 recorder.observe({kind:'trade',portfolioId:'b',record});
 recorder.observe({kind:'trade',portfolioId:'a',record});recorder.observe({kind:'trade',portfolioId:'a',record:{...record,updatedAt:new Date()}});
 recorder.observe({kind:'trade',portfolioId:'a',record:{...record,status:'CLOSED',exitFillIds:['f2'],actualExitPrice:110}});
 await recorder.flush();assert.equal(writes.length,2);assert.equal((writes[1].update as any).$setOnInsert.data.actualExitPrice,110);
});

test('robot records only actual start/stop transitions',async()=>{
 const writes:RuntimeWrite[]=[],recorder=new RuntimeRecorder(async w=>{writes.push(w);},()=>new Date(0));
 for(const [previous,running] of [[false,true],[true,false],[false,false],[false,false],[false,true]])recorder.observe({kind:'robot',portfolioId:'a',previous,running});
 await recorder.flush();assert.deepEqual(writes.map(w=>(w.update as any).$setOnInsert.event),['ROBOT_STARTED','ROBOT_STOPPED','ROBOT_STARTED']);
});

test('central sanitizer covers nested credentials, embedded credentials, errors, Date and cycles',()=>{
 const input:any={apiKey:'key',api_secret:'secret',headers:{Authorization:'Bearer abc',cookie:'session'},password:'password',telegramBotToken:'token',
  mongoUri:'mongodb://person:password@host/db',message:'mongodb+srv://person:password@host/db Bearer abc 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZABCDE',
  error:new Error('api_key=abcd secret=abcdef'),nested:['known-private-value'],date:new Date(0)};input.circular=input;
 const result=sanitize(input,['known-private-value']);
 assert.equal(result.apiKey,'[REDACTED]');assert.equal(result.api_secret,'[REDACTED]');assert.equal(result.headers.Authorization,'[REDACTED]');
 assert.equal(result.telegramBotToken,'[REDACTED]');assert.equal(result.mongoUri,'[REDACTED]');assert.equal(result.nested[0],'[REDACTED]');
 assert.ok(result.date instanceof Date);assert.equal(result.circular,'[CIRCULAR]');assert.doesNotMatch(JSON.stringify(result),/person:password|Bearer abc|ABCDEFGHIJKLMNOPQRSTUVWXYZ|=abcd/);
});

test('TTL and partial unique indexes are scoped exclusively to runtime events',()=>{
 assert.equal(runtimeEventIndexes.find(i=>i.name==='runtime_ttl')!.expireAfterSeconds,604800);
 assert.deepEqual(runtimeEventIndexes.find(i=>i.name==='runtime_ttl')!.key,{createdAt:1});
 assert.deepEqual(runtimeEventIndexes.find(i=>i.name==='decision_identity')!.partialFilterExpression,{eventType:'DECISION'});
});

test('actual worker executes identical decisions, orders and protection when runtime persistence fails',async()=>{
 const recorder=new RuntimeRecorder(async()=>{throw new Error('runtime logging failed');});
 const original=vm.runInNewContext;
 // Extend only the I/O boundary supplied by the existing executable worker harness.
 // The worker and protected harness/expectations remain unchanged.
 vm.runInNewContext=((code:any,context:any,options:any)=>{
  const require=context.require;
  context.require=(name:string)=>{const module=require(name);return name==='./lib/state'?{...module,observeRuntime:recorder.observe.bind(recorder)}:module;};
  return original(code,context,options);
 }) as typeof original;
 let observed:ReturnType<typeof workerHarness>;
 try{observed=workerHarness();}finally{vm.runInNewContext=original;}
 const baseline=workerHarness();
 const candles=[90,92,94,96].map((close,i)=>({time:i*300,open:close,high:close+1,low:close-1,close}));
 candles.push({time:1200,open:97,high:101,low:96,close:100});
 for(const worker of [baseline,observed!]){
  await worker.cycle(1502,candles,102);
  await worker.cycle(1802,[...candles,{time:1500,open:100,high:100,low:100,close:100}],102);
 }
 await recorder.flush();assert.ok(recorder.diagnostics.failed>0);
 assert.equal(observed!.orders.length,1);assert.equal(observed!.brackets.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(observed!.orders)),JSON.parse(JSON.stringify(baseline.orders)));
 assert.deepEqual(JSON.parse(JSON.stringify(observed!.brackets)),JSON.parse(JSON.stringify(baseline.brackets)));
 assert.deepEqual(JSON.parse(JSON.stringify(observed!.inspect().uiLogs)),JSON.parse(JSON.stringify(baseline.inspect().uiLogs)));
 observed!.stop();await observed!.cycle(1803,[...candles,{time:1500,open:100,high:100,low:100,close:100}],104);
 assert.equal(observed!.orders.length,1);assert.equal(observed!.status().running,false);
 assert.equal(observed!.status().position.size!==0,true);await recorder.flush();
});
