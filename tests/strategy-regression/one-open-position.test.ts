import assert from 'node:assert/strict';
import test from 'node:test';
import {workerHarness} from './worker-harness';
import {type Candle} from '../../lib/strategy';
import {decisionLogPresentation} from '../../lib/decision-log';

const history:Candle[]=[90,92,94,96].map((close,i)=>({time:i*300,open:close,high:close+1,low:close-1,close}));
const buy=(time:number):Candle=>({time,open:90,high:101,low:89,close:100});
const sell=(time:number):Candle=>({time,open:100,high:101,low:79,close:80});
const neutral=(time:number):Candle=>({time,open:100,high:100,low:100,close:100});

for(const size of [2,-2])for(const direction of ['long','short']){
  test(`${size>0?'LONG':'SHORT'} position blocks new ${direction.toUpperCase()} signal`,async()=>{
    const worker=workerHarness();worker.existingPosition(size);
    const candle=direction==='long'?buy(1200):sell(1200);
    await worker.cycle(1502,[...history,candle],direction==='long'?102:78);
    const log=worker.status().logs[0];
    assert.equal(log.setup.direction,direction);
    assert.equal(log.strategyLifecycle.currentSignal.action,'NOT_ACTIVATED');
    assert.equal(log.strategyLifecycle.pendingExists,false);
    assert.match(decisionLogPresentation(log).title,/POSITION OPEN NEW ENTRY BLOCKED/);
    assert.doesNotMatch(decisionLogPresentation(log).title,/WAITING FOR BREAKOUT/);
    assert.equal(worker.inspect().pending,null);
    assert.equal(worker.orders.length,0);
    assert.equal(worker.inspect().activeTrade.positionSize,size);
    assert.equal(worker.inspect().activeTrade.orderId,'existing-order');
  });
}

test('multiple alternating signals while open remain informational with no pending or order',async()=>{
  const worker=workerHarness();worker.existingPosition(-2);
  const candles=[...history];
  for(let i=0;i<6;i++){
    const candle=i%2? sell(1200+i*300):buy(1200+i*300);candles.push(candle);
    await worker.cycle(candle.time+302,candles,i%2?78:102);
    assert.ok(worker.status().logs[0].setup);
    assert.equal(worker.inspect().pending,null);
    assert.equal(worker.orders.length,0);
    assert.equal(worker.inspect().activeTrade.orderId,'existing-order');
  }
});

test('open-trade signals and the candle first delivered at flat confirmation cannot replay',async()=>{
  const worker=workerHarness();worker.existingPosition(2);
  await worker.cycle(1502,[...history,buy(1200)],102);
  await worker.cycle(1802,[...history,buy(1200),sell(1500)],78);
  worker.setPosition(0);
  const candles=[...history,buy(1200),sell(1500),buy(1800)];
  await worker.cycle(2102,candles,102);
  assert.equal(worker.inspect().pending,null);
  await worker.cycle(2108,candles,102);
  await worker.cycle(2402,[...candles,neutral(2100)],102);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.orders.length,0);
});

test('only a new completed signal after confirmed flat creates pending and enters on following candle',async()=>{
  const worker=workerHarness();worker.existingPosition(-2);
  await worker.cycle(1502,[...history,buy(1200)],102);
  worker.setPosition(0);
  const candles=[...history,buy(1200),sell(1500)];
  await worker.cycle(1802,candles,78);
  candles.push(buy(1800));
  await worker.cycle(2102,candles,102);
  assert.equal(worker.inspect().pending?.candleTime,1800);
  assert.equal(worker.orders.length,0);
  await worker.cycle(2103,candles,102);
  assert.equal(worker.orders.length,0);
  candles.push(neutral(2100));
  await worker.cycle(2402,candles,102);
  assert.equal(worker.orders.length,1);
  assert.equal(worker.intents[0].signalCandleTime,1800);
  assert.equal(worker.inspect().pending,null);
});

test('successful pending is consumed and repeated open-position cycles cannot enter twice',async()=>{
  const worker=workerHarness();const candles=[...history,buy(1200)];
  await worker.cycle(1502,candles,102);
  candles.push(neutral(1500));await worker.cycle(1802,candles,102);
  assert.equal(worker.orders.length,1);
  assert.equal(worker.inspect().pending,null);
  for(const time of [1803,1808,1815])await worker.cycle(time,candles,102);
  candles.push(sell(1800));await worker.cycle(2102,candles,78);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.orders.length,1);
  assert.equal(worker.persisted.length,1);
});

for(const reads of [[0,0,2],[0,0,0,-2]])test(`fresh position blocks entry at ${reads.length===3?'first':'submission-adjacent'} final barrier`,async()=>{
  const worker=workerHarness();
  await worker.cycle(1502,[...history,buy(1200)],102);
  worker.queuePositionReads(...reads);
  // The adjacent barrier throws EntryNotTransmittedError in this I/O stub.
  try{await worker.cycle(1802,[...history,buy(1200),neutral(1500)],102);}catch(error){assert.match(String(error),/FINAL_PREORDER_POSITION_NONZERO/);}
  assert.equal(worker.orders.length,0);
  assert.equal(worker.inspect().pending,null);
  assert.ok(worker.inspect().tradeEvents.some((event:any)=>event.type==='FINAL_PREORDER_POSITION_NONZERO'));
});

test('a newly observed position clears an existing pending even on the same candle',async()=>{
  const worker=workerHarness();const candles=[...history,buy(1200)];
  await worker.cycle(1502,candles,100);
  assert.ok(worker.inspect().pending);
  worker.existingPosition(-2);
  await worker.cycle(1508,candles,102);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.status().logs[0].pending,null);
  assert.match(decisionLogPresentation(worker.status().logs[0]).title,/POSITION OPEN NEW ENTRY BLOCKED/);
  assert.equal(worker.orders.length,0);
});

test('confirmed entry consumes pending before persistence can fail',async()=>{
  const worker=workerHarness();const candles=[...history,buy(1200)];
  await worker.cycle(1502,candles,102);
  worker.failOpenPersistence();candles.push(neutral(1500));
  await assert.rejects(worker.cycle(1802,candles,102),/test persistence unavailable/);
  assert.equal(worker.orders.length,1);
  assert.equal(worker.inspect().pending,null);
  await worker.cycle(1803,candles,102);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.orders.length,1);
});
