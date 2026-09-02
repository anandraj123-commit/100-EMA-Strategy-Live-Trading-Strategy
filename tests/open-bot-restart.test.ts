import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TradeDocument } from '../models/Trade';
import { restoreOpenBotTrade } from '../lib/trades/open-bot-restoration';
import { persistOpenBotTrade,type TradePersistenceDependencies } from '../lib/trades/persistence';

const strategyConfig={resolution:'5m',emaLength:100,slopeLookback:3,entryValidCandles:2,rr:8,riskPct:1,riskBase:'available',orderLeverage:100,maxEffectiveLeverage:100,priceSource:'last',configRevision:'original-revision'};
const persisted={tradeId:'bot:27:entry-1',symbol:'XAUTUSD',productId:27,side:'LONG',source:'bot',attributionStatus:'BOT_CONFIRMED',status:'OPEN',entryTime:new Date(1_000),intendedEntryPrice:100,actualEntryPrice:101,quantity:5,contracts:5,contractValue:1,riskAmount:25,takerRate:0.0005,gstPct:18,initialSL:90,takeProfit:181,exitTime:null,intendedExitPrice:null,actualExitPrice:null,exitReason:'UNKNOWN',grossPnL:null,brokerage:null,GST:null,otherCharges:null,totalCharges:null,netPnL:null,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:null,entryOrderId:'entry-1',exitOrderId:null,entryClientOrderId:'client-1',exitClientOrderId:null,entryFillIds:['fill-1'],exitFillIds:[],financialStatus:'unavailable',feeDataSource:null,priceDataSource:null,attributionNote:null,reconciliationError:null,reconciledAt:null,entryIntentId:'intent-1',protectionState:'ACTIVE',strategyConfig,createdAt:new Date(1_000),updatedAt:new Date(1_000)} as TradeDocument;

const restore=(record:TradeDocument=persisted)=>restoreOpenBotTrade(record,{size:8,entry_price:140},{botOwnedContracts:5,mixedPosition:true},2);

test('restart restores the original BOT entry instead of the aggregate Delta entry',()=>assert.equal(restore().entryPrice,101));
test('restart restores original SL and TP despite changed runtime strategy settings',()=>assert.deepEqual([restore().sl,restore().tp],[90,181]));
test('restart restores original BOT contracts and keeps manual same-side exposure separate',()=>assert.deepEqual([restore().contracts,restore().ownedContracts,restore().positionSize,restore().mixedPosition],[5,5,8,true]));
test('restart restores original entry order, client order, and fill identities',()=>assert.deepEqual([restore().orderId,restore().clientOrderId,restore().entryFillIds],['entry-1','client-1',['fill-1']]));
test('restart restores original risk and fee inputs for eventual close accounting',()=>assert.deepEqual([restore().riskAmount,restore().takerRate,restore().gstPct],[25,0.0005,18]));
test('restart restores the original immutable strategy snapshot',()=>assert.deepEqual(restore().strategyConfig,strategyConfig));
test('restart restores entry intent and protection state',()=>assert.deepEqual([restore().entryIntentId,restore().protectionState],['intent-1','ACTIVE']));
test('repeated restart reconstruction is idempotent',()=>assert.deepEqual(restore(),restore()));
test('persisted entry is used when actual fill price is unavailable',()=>assert.equal(restore({...persisted,actualEntryPrice:null}).entryPrice,100));
test('Delta entry is only a legacy fallback when persisted entry prices are unavailable',()=>assert.equal(restore({...persisted,actualEntryPrice:null,intendedEntryPrice:null}).entryPrice,140));

test('OPEN BOT persistence stores every immutable restart input',async()=>{
  let saved:any;
  const dependencies:TradePersistenceDependencies={upsert:(async(document:any)=>saved=document) as any,fills:(async()=>({result:[],complete:true})) as any,orders:(async()=>({result:[],complete:true})) as any,now:()=>2_000};
  await persistOpenBotTrade({direction:'long',trigger:100,actualEntryPrice:101,sl:90,tp:181,contracts:5,ownedContracts:5,contractValue:1,riskAmount:25,takerRate:0.0005,gstPct:18,orderId:'entry-1',clientOrderId:'client-1',entryFillIds:['fill-1'],entryIntentId:'intent-1',protectionState:'ACTIVE',openedAt:1_000,strategyConfig},27,'XAUTUSD',dependencies);
  assert.deepEqual({entry:saved.actualEntryPrice,trigger:saved.intendedEntryPrice,sl:saved.initialSL,tp:saved.takeProfit,contracts:saved.contracts,risk:saved.riskAmount,rate:saved.takerRate,gst:saved.gstPct,order:saved.entryOrderId,client:saved.entryClientOrderId,fills:saved.entryFillIds,intent:saved.entryIntentId,protection:saved.protectionState,config:saved.strategyConfig},{entry:101,trigger:100,sl:90,tp:181,contracts:5,risk:25,rate:0.0005,gst:18,order:'entry-1',client:'client-1',fills:['fill-1'],intent:'intent-1',protection:'ACTIVE',config:strategyConfig});
});

test('protection repair remains driven by restored activeTrade prices, not current RR or risk settings',()=>{
  const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const start=worker.indexOf('async function syncExchangeBracket');
  const end=worker.indexOf('const sleep=',start);
  const repair=worker.slice(start,end);
  assert.match(repair,/intendedSl=Number\(activeTrade\.sl\)/);
  assert.match(repair,/intendedTp=Number\(activeTrade\.tp\)/);
  assert.doesNotMatch(repair,/config\.rr|config\.riskPct|evaluateSetup/);
});
