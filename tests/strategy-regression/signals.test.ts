import assert from 'node:assert/strict';
import test from 'node:test';
import { emaSeries, evaluateSetup, type Candle } from '../../lib/strategy';

const bar = (time:number, close:number):Candle => ({time, open:close, high:close+1, low:close-1, close});
const prefix = (closes:number[]) => closes.map((close, i) => bar(i*300, close));
const rising = prefix([90,92,94,96]);
const falling = prefix([110,108,106,104]);

for (const [name, history, signal, expected] of [
  ['BUY A', rising, {time:1200,open:97,high:101,low:96,close:100}, {direction:'long',trigger:101,sl:96}],
  ['BUY B', rising, {time:1200,open:99,high:101,low:98,close:100}, {direction:'long',trigger:101,sl:98}],
  ['SELL A', falling, {time:1200,open:103,high:104,low:99,close:100}, {direction:'short',trigger:99,sl:104}],
  ['SELL B', falling, {time:1200,open:101,high:102,low:99,close:100}, {direction:'short',trigger:99,sl:102}],
] as const) {
  test(`${name}: configured EMA trend, exact signal trigger and SL`, () => {
    const result = evaluateSetup([...history, signal], 2, 1);
    assert.ok(result);
    assert.deepEqual({direction:result.direction,trigger:result.trigger,sl:result.sl}, expected);
    assert.equal(result.candleTime, signal.time);
    const opposite = expected.direction === 'long' ? falling : rising;
    assert.equal(evaluateSetup([...opposite, signal], 2, 1), null);
  });
}

for (const direction of ['long','short'] as const) {
  test(`${direction} B includes exact EMA touch and rejects a wick that misses EMA`, () => {
    const history = direction === 'long' ? rising : falling;
    const e = emaSeries([...history.map(c => c.close),100],2).at(-1)!;
    const signal:Candle = direction === 'long'
      ? {time:1200,open:99,high:101,low:e,close:100}
      : {time:1200,open:101,high:e,low:99,close:100};
    const setup = evaluateSetup([...history,signal],2,1);
    assert.equal(setup?.direction,direction);
    assert.equal(setup?.sl,e);
    const missed = direction === 'long' ? {...signal,low:e+0.01} : {...signal,high:e-0.01};
    assert.equal(evaluateSetup([...history,missed],2,1),null);
    assert.equal(evaluateSetup([...history,{...signal,open:e}],2,1),null);
  });
  test(`${direction} close equal to EMA does not satisfy A or B`, () => {
    const history = direction === 'long' ? rising : falling;
    const e = emaSeries(history.map(c=>c.close),2).at(-1)!;
    for (const open of [e-1,e,e+1]) {
      assert.equal(evaluateSetup([...history,{time:1200,open,high:e+2,low:e-2,close:e}],2,1),null);
    }
  });
}

test('EMA uses an SMA seed, null warmup, and exact recursive values', () => {
  assert.deepEqual(emaSeries([2,4],3),[null,null]);
  assert.deepEqual(emaSeries([2,4,6,10,8],3),[null,null,4,7,7.5]);
  const shorter=emaSeries([2,4,6,10,8],2);
  assert.deepEqual(shorter.slice(0,3),[null,3,5]);
  assert.ok(Math.abs(shorter[3]!-25/3)<1e-12);
  assert.ok(Math.abs(shorter[4]!-73/9)<1e-12);
});

test('EMA 75 and EMA 100 use distinct configured seeds and recursive series', () => {
  const closes = Array.from({length:110},(_,i)=>i+1);
  for (const length of [75,100]) {
    const ema = emaSeries(closes,length);
    assert.ok(ema.slice(0,length-1).every(value=>value===null));
    for (let i=length-1;i<closes.length;i++) {
      assert.ok(Math.abs(ema[i]!-(i+1-(length-1)/2))<1e-10);
    }
  }
  const history=prefix(closes);
  const signal={time:110*300,open:70,high:120,low:69,close:111};
  assert.equal(evaluateSetup([...history,signal],75,3)?.direction,'long');
  // EMA100 is below the entire candle, so it must not accidentally use EMA75.
  assert.equal(evaluateSetup([...history,signal],100,3),null);
});

test('slopeLookback > 1 compares EMA[current-N], not the immediately preceding EMA', () => {
  const risingBounce=[...prefix([20,20,20,10,12]),{time:1500,open:13,high:15,low:12,close:14}];
  assert.equal(evaluateSetup(risingBounce,3,1)?.direction,'long');
  assert.equal(evaluateSetup([...prefix([20,20]),...risingBounce.map(c=>({...c,time:c.time+600}))],3,2),null);
  const fallingBounce=[...prefix([0,0,0,10,8]),{time:1500,open:7,high:8,low:5,close:6}];
  assert.equal(evaluateSetup(fallingBounce,3,1)?.direction,'short');
  assert.equal(evaluateSetup([...prefix([0,0]),...fallingBounce.map(c=>({...c,time:c.time+600}))],3,2),null);
});

for (const direction of ['long','short'] as const) {
  test(`${direction}: lookback 3 UP/DOWN and equality are exact`, () => {
    const history=prefix(direction==='long'?[10,10,10,10,10,8,10]:[10,10,10,10,10,12,10]);
    const equalClose=direction==='long'?10.5:9.5;
    const signal={time:2100,open:direction==='long'?9:11,high:12,low:8,close:equalClose};
    assert.equal(emaSeries([...history.map(c=>c.close),equalClose],3).at(-1),10);
    assert.equal(evaluateSetup([...history,signal],3,3),null);
    assert.equal(evaluateSetup([...history,signal],3,2)?.direction,direction);
    const trending={...signal,close:equalClose+(direction==='long'?0.25:-0.25)};
    assert.equal(evaluateSetup([...history,trending],3,3)?.direction,direction);
  });
}
