import assert from 'node:assert/strict';
import test from 'node:test';
import {workerHarness} from './worker-harness';
import {type Candle} from '../../lib/strategy';

const history:Candle[]=[90,92,94,96].map((close,i)=>({time:i*300,open:close,high:close+1,low:close-1,close}));
const signal:Candle={time:1200,open:97,high:101,low:96,close:100};

test('real worker rejects incomplete signal candles even if live price is beyond the trigger',async()=>{
  const worker=workerHarness();
  await worker.cycle(1499,[...history,signal],102);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.orders.length,0);
});

test('real worker uses completed signal OHLC and clears pending when Robot stops',async()=>{
  const worker=workerHarness();
  await worker.cycle(1502,[...history,signal],101);
  assert.equal(worker.inspect().pending?.trigger,101);
  assert.equal(worker.inspect().pending?.sl,96);
  const log=worker.status().logs.find((row:any)=>row.candleTime===1200);
  assert.equal(log.buy.patternA,true);
  assert.equal(log.ema.direction,'UP');
  assert.equal(worker.orders.length,0);
  worker.stop();
  await worker.cycle(1503,[...history,signal],101);
  assert.equal(worker.inspect().pending,null);
  assert.equal(worker.orders.length,0);
});
