import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {config} from '../lib/config';
import {placeBracket,placeMarketOrder,placeProtectiveStopOrder} from '../lib/delta';
import {evaluateSetup,type Candle} from '../lib/strategy';

const candle=(time:number,open:number,high:number,low:number,close:number):Candle=>({time,open,high,low,close});
const risingPrefix=[candle(1,90,91,89,90),candle(2,92,93,91,92),candle(3,94,95,93,94),candle(4,96,97,95,96)];
const fallingPrefix=[candle(1,110,111,109,110),candle(2,108,109,107,108),candle(3,106,107,105,106),candle(4,104,105,103,104)];

test('BUY reclaim and rejection/touch require rising EMA and preserve signal HIGH/LOW',()=>{
  const reclaim=evaluateSetup([...risingPrefix,candle(5,97,101,96,100)],2,1);
  const rejection=evaluateSetup([...risingPrefix,candle(5,99,101,98,100)],2,1);
  assert.deepEqual(reclaim&&{direction:reclaim.direction,trigger:reclaim.trigger,sl:reclaim.sl},{direction:'long',trigger:101,sl:96});
  assert.deepEqual(rejection&&{direction:rejection.direction,trigger:rejection.trigger,sl:rejection.sl},{direction:'long',trigger:101,sl:98});
  assert.equal(evaluateSetup([...fallingPrefix,candle(5,97,101,96,100)],2,1),null);
});

test('SELL reclaim and rejection/touch require falling EMA and preserve signal LOW/HIGH',()=>{
  const reclaim=evaluateSetup([...fallingPrefix,candle(5,103,104,99,100)],2,1);
  const rejection=evaluateSetup([...fallingPrefix,candle(5,101,102,99,100)],2,1);
  assert.deepEqual(reclaim&&{direction:reclaim.direction,trigger:reclaim.trigger,sl:reclaim.sl},{direction:'short',trigger:99,sl:104});
  assert.deepEqual(rejection&&{direction:rejection.direction,trigger:rejection.trigger,sl:rejection.sl},{direction:'short',trigger:99,sl:102});
  assert.equal(evaluateSetup([...risingPrefix,candle(5,103,104,99,100)],2,1),null);
});

test('insufficient or malformed strategy data cannot create a setup',()=>{
  assert.equal(evaluateSetup(risingPrefix,2,1),null);
  assert.equal(evaluateSetup([...risingPrefix,candle(5,99,101,98,Number.NaN)],2,1),null);
});

test('entry and bracket APIs submit only market orders with exact identity, side, quantity, and trigger source',async()=>{
  const originalFetch=globalThis.fetch,originalKey=config.apiKey,originalSecret=config.apiSecret;
  const requests:Array<{url:string;init:RequestInit;body:any}>=[];
  config.apiKey='x';config.apiSecret='x';
  globalThis.fetch=(async(url:string|URL|Request,init:RequestInit={})=>{requests.push({url:String(url),init,body:init.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify({success:true,result:{id:'accepted'}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  try{
    await placeMarketOrder(27,'buy',5,'durable-buy');
    await placeMarketOrder(28,'sell',7,'durable-sell');
    await placeBracket(27,90,180,'mark_price');
    await placeBracket(28,110,20,'spot_price');
    assert.deepEqual(requests.slice(0,2).map(request=>request.body),[
      {product_id:27,size:5,side:'buy',order_type:'market_order',time_in_force:'ioc',reduce_only:false,client_order_id:'durable-buy',cancel_orders_accepted:false},
      {product_id:28,size:7,side:'sell',order_type:'market_order',time_in_force:'ioc',reduce_only:false,client_order_id:'durable-sell',cancel_orders_accepted:false}
    ]);
    for(const request of requests.slice(2)){
      assert.equal(request.body.stop_loss_order.order_type,'market_order');
      assert.equal(request.body.take_profit_order.order_type,'market_order');
      assert.equal(JSON.stringify(request.body).includes('limit_order'),false);
    }
    assert.equal(requests[2].body.bracket_stop_trigger_method,'mark_price');
    assert.equal(requests[3].body.bracket_stop_trigger_method,'spot_price');
  }finally{globalThis.fetch=originalFetch;config.apiKey=originalKey;config.apiSecret=originalSecret;}
});

test('independent protective repairs are reduce-only market orders with durable identity',async()=>{
  const originalFetch=globalThis.fetch,originalKey=config.apiKey,originalSecret=config.apiSecret;
  const bodies:any[]=[];config.apiKey='x';config.apiSecret='x';
  globalThis.fetch=(async(_url:string|URL|Request,init:RequestInit={})=>{bodies.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({success:true,result:{id:'accepted'}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  try{
    await placeProtectiveStopOrder(27,'sell',5,'stop_loss_order',90,'last_traded_price','repair-sl');
    await placeProtectiveStopOrder(27,'sell',5,'take_profit_order',180,'last_traded_price','repair-tp');
    assert.deepEqual(bodies.map(body=>({kind:body.stop_order_type,type:body.order_type,reduceOnly:body.reduce_only,identity:body.client_order_id,trigger:body.stop_trigger_method})),[
      {kind:'stop_loss_order',type:'market_order',reduceOnly:true,identity:'repair-sl',trigger:'last_traded_price'},
      {kind:'take_profit_order',type:'market_order',reduceOnly:true,identity:'repair-tp',trigger:'last_traded_price'}
    ]);
  }finally{globalThis.fetch=originalFetch;config.apiKey=originalKey;config.apiSecret=originalSecret;}
});

test('live-price observation has no independent emergency market-close path',()=>{
  const source=fs.readFileSync(new URL('../worker.ts',import.meta.url),'utf8');
  const marketCalls=[...source.matchAll(/placeMarketOrder\(/g)];
  assert.equal(marketCalls.length,1);
  const callContext=source.slice(Math.max(0,marketCalls[0].index!-1_000),marketCalls[0].index!+200);
  assert.match(callContext,/submitPreparedEntryIntent/);
  assert.doesNotMatch(source,/placeMarketOrder\([^\n]*(?:reduce_only|activeTrade\.(?:sl|tp)|lastPrice\s*[<>])/);
});
