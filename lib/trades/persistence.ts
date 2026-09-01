import { config } from '../config';
import { getFillsBounded, getOrderHistoryBounded, toDeltaMicroseconds } from '../delta';
import type { TradeDocument, TradeExitReason, TradeSide, TradeSource } from '../../models/Trade';
import { aggregateCommission, attributeTradeFills, deltaTimestampMilliseconds, financials, stableTradeId, weightedAverage, type DeltaFill } from './reconciliation';
import { findClosedExitFillClaim, findManualEntryFillClaim, upsertTrade } from './repository';

const id=(v:unknown)=>v==null?null:String(v);
const date=(v:unknown)=>{const d=v?new Date(String(v)):null;return d&&!Number.isNaN(d.valueOf())?d:null;};
const num=(v:unknown)=>{const n=Number(v);return v!==null&&v!==''&&Number.isFinite(n)?n:null;};
const fillId=(f:DeltaFill)=>id(f.id);
export interface TradePersistenceDependencies {upsert:typeof upsertTrade;fills:typeof getFillsBounded;orders:typeof getOrderHistoryBounded;now:()=>number;findEntryClaim?:typeof findManualEntryFillClaim;findExitClaim?:typeof findClosedExitFillClaim;}
export type TradeRuntimeContext={portfolioId:string;environment:'real'|'demo'};
const defaultDependencies:TradePersistenceDependencies={upsert:upsertTrade,fills:getFillsBounded,orders:getOrderHistoryBounded,now:()=>Date.now(),findEntryClaim:findManualEntryFillClaim,findExitClaim:findClosedExitFillClaim};

export interface ActiveTradeSnapshot {
  direction?:string; source?:TradeSource; entryPrice?:number; trigger?:number; sl?:number|null; tp?:number|null;
  contracts?:number; ownedContracts?:number; contractValue?:number; orderId?:string|number|null; clientOrderId?:string|null;
  openedAt?:number|null; adoptedAt?:number|null; riskAmount?:number|null; takerRate?:number|null; gstPct?:number|null;
  lastObservedAt?:number|null; attributionStatus?:string; mixedPosition?:boolean;
  tradeId?:string|null;
  closedAtBoundary?:number|null;
  entryFillIds?:string[];
  strategyConfig?:TradeDocument['strategyConfig'];
  entryIntentId?:string|null;
  protectionState?:TradeDocument['protectionState'];
  actualEntryPrice?:number|null;
}

export async function persistOpenBotTrade(trade:ActiveTradeSnapshot, productId:number, symbol:string,dependencies:TradePersistenceDependencies=defaultDependencies,context?:TradeRuntimeContext) {
  const entryOrderId=id(trade.orderId); const baseTradeId=stableTradeId('bot',productId,entryOrderId,[],[]);const tradeId=baseTradeId&&context?`${context.environment}:${context.portfolioId}:${baseTradeId}`:baseTradeId;
  if(!tradeId) throw new Error('Cannot persist bot ownership without an exchange order identifier');
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG'; const contracts=num(trade.ownedContracts??trade.contracts); const cv=num(trade.contractValue);
  return dependencies.upsert({tradeId,...context,symbol,productId,side,source:'bot',...(trade.strategyConfig?{strategyConfig:trade.strategyConfig}:{}),entryIntentId:trade.entryIntentId??null,protectionState:trade.protectionState??'PENDING',protectionUpdatedAt:new Date(dependencies.now()),attributionStatus:'BOT_CONFIRMED',status:'OPEN',entryTime:trade.openedAt?new Date(trade.openedAt):null,intendedEntryPrice:num(trade.trigger??trade.entryPrice),actualEntryPrice:num(trade.actualEntryPrice),quantity:contracts!=null&&cv!=null?contracts*cv:null,contracts,contractValue:cv,initialSL:num(trade.sl),takeProfit:num(trade.tp),exitTime:null,intendedExitPrice:null,actualExitPrice:null,exitReason:'UNKNOWN',grossPnL:null,brokerage:null,GST:null,otherCharges:null,totalCharges:null,netPnL:null,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:null,entryOrderId,exitOrderId:null,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:null,entryFillIds:trade.entryFillIds??[],exitFillIds:[],financialStatus:'unavailable',feeDataSource:null,priceDataSource:null,attributionNote:null,reconciliationError:null,reconciledAt:null});
}

export async function persistOpenManualTrade(trade:ActiveTradeSnapshot,productId:number,symbol:string,entryFills:DeltaFill[],dependencies:TradePersistenceDependencies=defaultDependencies,context?:TradeRuntimeContext){
  if(trade.source!=='exchange_existing'||trade.attributionStatus!=='MANUAL_CONFIRMED')throw new Error('Manual OPEN persistence requires MANUAL_CONFIRMED ownership');
  const entryFillIds=entryFills.map(fillId).filter((v):v is string=>!!v);const baseTradeId=stableTradeId('exchange_existing',productId,null,entryFillIds,[]);const tradeId=baseTradeId&&context?`${context.environment}:${context.portfolioId}:${baseTradeId}`:baseTradeId;
  if(!tradeId||!entryFillIds.length)throw new Error('Cannot persist manual ownership without stable Delta entry fill identifiers');
  if(dependencies.findEntryClaim&&await dependencies.findEntryClaim(entryFillIds,tradeId,context?.portfolioId))throw new Error('TRADE_HISTORY_ENTRY_FILL_ALREADY_CLAIMED');
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG',contracts=num(trade.ownedContracts??trade.contracts),cv=num(trade.contractValue),actualEntryPrice=weightedAverage(entryFills);
  if(actualEntryPrice==null)throw new Error('Cannot persist manual ownership without actual Delta entry prices');
  const entryTimeMs=Math.min(...entryFills.map(f=>deltaTimestampMilliseconds(f.created_at)??Infinity));const entryOrderIds=[...new Set(entryFills.map(f=>id(f.order_id)).filter((v):v is string=>!!v))];const entryOrderId=entryOrderIds.length===1?entryOrderIds[0]:null;const brokerage=aggregateCommission(entryFills);
  await dependencies.upsert({tradeId,...context,symbol,productId,side,source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED',status:'OPEN',entryTime:Number.isFinite(entryTimeMs)?new Date(entryTimeMs):null,intendedEntryPrice:null,actualEntryPrice,quantity:contracts!=null&&cv!=null?contracts*cv:contracts,contracts,contractValue:cv,initialSL:num(trade.sl),takeProfit:num(trade.tp),exitTime:null,intendedExitPrice:null,actualExitPrice:null,exitReason:'UNKNOWN',grossPnL:null,brokerage,GST:null,otherCharges:null,totalCharges:null,netPnL:null,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:null,entryOrderId,exitOrderId:null,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:null,entryFillIds,exitFillIds:[],financialStatus:'unavailable',feeDataSource:brokerage!=null?'delta_fills_commission':null,priceDataSource:'delta_weighted_fills',attributionNote:'Manual position adopted from complete Delta opening lifecycle',reconciliationError:null,reconciledAt:null});
  return {tradeId,entryFillIds,entryTime:Number.isFinite(entryTimeMs)?entryTimeMs:null,actualEntryPrice};
}

function exitReason(order:any):TradeExitReason {
  if(order?.stop_order_type==='stop_loss_order') return 'SL';
  if(order?.stop_order_type==='take_profit_order') return 'TP';
  return order?'MANUAL_CLOSE':'UNKNOWN';
}

export async function persistClosedTrade(trade:ActiveTradeSnapshot, productId:number, symbol:string, observedExitPrice:number|null,dependencies:TradePersistenceDependencies=defaultDependencies,context?:TradeRuntimeContext) {
  const source:TradeSource=trade.source==='bot'?'bot':'exchange_existing';
  if(trade.attributionStatus==='UNKNOWN'||trade.attributionStatus==='LOOKUP_FAILED'||(trade.source!=='bot'&&trade.source!=='exchange_existing')) throw new Error('TRADE_HISTORY_RECONCILIATION_UNRESOLVED: ownership is not confirmed');
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG';
  const openedMs=trade.openedAt??trade.adoptedAt??dependencies.now()-24*60*60*1000;
  const startMicros=toDeltaMicroseconds(Math.max(0,openedMs-60_000));
  const [fillsResponse,ordersResponse]=await Promise.all([dependencies.fills(productId,startMicros),dependencies.orders(productId,startMicros)]);
  const fills:DeltaFill[]=Array.isArray(fillsResponse?.result)?fillsResponse.result:[];
  const orders:any[]=Array.isArray(ordersResponse?.result)?ordersResponse.result:[];
  const entryOrderId=id(trade.orderId);
  const targetContracts=Math.abs(Number(trade.ownedContracts??trade.contracts??0));
  const windowStart=openedMs-60_000;
  const attribution=attributeTradeFills({source,side,productId,ownedContracts:targetContracts,entryOrderId,entryFillIds:trade.entryFillIds,fills,orders,windowStart,windowEnd:trade.closedAtBoundary??dependencies.now()+5_000,historyComplete:fillsResponse.complete&&ordersResponse.complete,mixedPosition:trade.mixedPosition===true});
  if(!attribution.complete) throw new Error(`TRADE_HISTORY_RECONCILIATION_INCOMPLETE: ${attribution.reason}`);
  const entryFills=attribution.entryFills, exitFills=attribution.exitFills;
  const entryFillIds=entryFills.map(fillId).filter((v):v is string=>!!v), exitFillIds=exitFills.map(fillId).filter((v):v is string=>!!v);
  const resolvedId=stableTradeId(source,productId,entryOrderId,entryFillIds,exitFillIds);
  if(!resolvedId) throw new Error('No stable exchange identity available; refusing timestamp-only trade persistence');
  const tradeId=trade.tradeId??resolvedId;
  if(dependencies.findExitClaim&&await dependencies.findExitClaim(exitFillIds,tradeId,context?.portfolioId))throw new Error('TRADE_HISTORY_EXIT_FILL_ALREADY_CLAIMED');
  const contracts=num(trade.ownedContracts??trade.contracts), cv=num(trade.contractValue), quantity=contracts!=null&&cv!=null?contracts*cv:contracts;
  const actualEntry=weightedAverage(entryFills);
  const actualExit=weightedAverage(exitFills);
  const entryForPnl=actualEntry;
  const exitForPnl=actualExit;
  const estimateEntry=entryForPnl??num(trade.entryPrice), estimateExit=actualExit??num(observedExitPrice);
  const rate=num(trade.takerRate); const estimatedBrokerage=rate!=null&&quantity!=null&&estimateEntry!=null&&estimateExit!=null?quantity*(estimateEntry+estimateExit)*rate:null;
  const gstPct=num(trade.gstPct??config.gstPct); const estimatedGST=estimatedBrokerage!=null&&gstPct!=null?estimatedBrokerage*gstPct/100:null;
  const money=financials({side,entry:entryForPnl,exit:exitForPnl,quantity,entryFills,exitFills,estimatedBrokerage,estimatedGST,manualCommissionIncludesGST:source==='exchange_existing'});
  const exitOrderIds=[...new Set(exitFills.map(f=>id(f.order_id)).filter((v):v is string=>!!v))],exitOrders=exitOrderIds.map(orderId=>orders.find(o=>id(o.id)===orderId)),exitReasons=new Set(exitOrders.map(exitReason));
  const provenExitReason:TradeExitReason=exitOrders.every(Boolean)&&exitReasons.size===1?[...exitReasons][0]:'UNKNOWN';
  const exitOrderId=exitOrderIds.length===1?exitOrderIds[0]:null;const exitOrder=exitOrderId?orders.find(o=>id(o.id)===exitOrderId):null;
  const exitAt=exitFills.map(f=>date(f.created_at)).filter((v):v is Date=>!!v).sort((a,b)=>b.valueOf()-a.valueOf())[0]??new Date(dependencies.now());
  const risk=num(trade.riskAmount); const realizedR=source==='bot'&&risk&&money.netPnL!=null?money.netPnL/risk:null;
  const doc:Omit<TradeDocument,'_id'|'createdAt'|'updatedAt'>={tradeId,...context,symbol,productId,side,source,attributionStatus:source==='bot'?'BOT_CONFIRMED':'MANUAL_CONFIRMED',status:'CLOSED',entryTime:entryFills.map(f=>date(f.created_at)).filter((v):v is Date=>!!v).sort((a,b)=>a.valueOf()-b.valueOf())[0]??(trade.openedAt?new Date(trade.openedAt):null),intendedEntryPrice:num(trade.trigger??trade.entryPrice),actualEntryPrice:actualEntry,quantity,contracts,contractValue:cv,initialSL:num(trade.sl),takeProfit:num(trade.tp),exitTime:exitAt,intendedExitPrice:num(observedExitPrice),actualExitPrice:actualExit,exitReason:provenExitReason,...money,realizedR,entryOrderId,exitOrderId,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:id(exitOrder?.client_order_id),entryFillIds,exitFillIds,reconciledAt:new Date(dependencies.now()),feeDataSource:money.brokerage!=null?'delta_fills_commission':estimatedBrokerage!=null?'configured_rate_estimate':null,priceDataSource:actualEntry!=null&&actualExit!=null?'delta_weighted_fills':actualExit!=null?'partial_delta_fills':'unavailable',attributionNote:attribution.reason,reconciliationError:null};
  await dependencies.upsert(doc);
  return doc;
}
