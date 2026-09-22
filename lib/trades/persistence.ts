import { observeRuntime } from '../runtime-events/logger';
import { entryExecutionMetrics, exposureMetrics, openExecutionPatch, uniqueFills } from './lifecycle';
import { config } from '../config';
import { getFillsBounded, getOrderHistoryBounded, toDeltaMicroseconds } from '../delta';
import type { TradeDocument, TradeExitReason, TradeSide, TradeSource } from '../../models/Trade';
import { aggregateCommission, attributeTradeFills, deltaTimestampMilliseconds, financials, stableTradeId, weightedAverage, type DeltaFill } from './reconciliation';
import { findClosedExitFillClaim, findManualEntryFillClaim, upsertTrade, findTradeLifecycle, mutateTradeLifecycle, confirmTradePositionClosed } from './repository';
import { claimTradeFills } from './fill-claims';

const id=(v:unknown)=>v==null?null:String(v);
const date=(v:unknown)=>{const ms=deltaTimestampMilliseconds(v);return ms==null?null:new Date(ms);};
const num=(v:unknown)=>{const n=Number(v);return v!==null&&v!==''&&Number.isFinite(n)?n:null;};
const fillId=(f:DeltaFill)=>id(f.id);
export interface TradePersistenceDependencies {confirmClose?:typeof confirmTradePositionClosed;upsert:typeof upsertTrade;fills:typeof getFillsBounded;orders:typeof getOrderHistoryBounded;now:()=>number;findEntryClaim?:typeof findManualEntryFillClaim;findExitClaim?:typeof findClosedExitFillClaim;claimFills?:typeof claimTradeFills;}
export type TradeRuntimeContext={portfolioId:string;environment:'real'|'demo'};
const defaultDependencies:TradePersistenceDependencies={confirmClose:confirmTradePositionClosed,upsert:upsertTrade,fills:getFillsBounded,orders:getOrderHistoryBounded,now:()=>Date.now(),findEntryClaim:findManualEntryFillClaim,findExitClaim:findClosedExitFillClaim,claimFills:claimTradeFills};

export interface ActiveTradeSnapshot {
  positionClosedAt?:number;
  entrySnapshot?: Pick<TradeDocument,'equityAtEntry'|'entryBid'|'entryAsk'|'entrySpreadAmount'|'entrySpreadPct'|'entrySpreadTime'>;
  initialSL?:number|null; takeProfit?:number|null;
  protectionSlOrderId?:string|null; protectionTpOrderId?:string|null;

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
  if(context&&dependencies.claimFills)await dependencies.claimFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId,fillIds:trade.entryFillIds??[],role:'ENTRY'});
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG'; const contracts=num(trade.ownedContracts??trade.contracts); const cv=num(trade.contractValue);
  return dependencies.upsert({tradeId,...context,...trade.entrySnapshot,entryDataStatus:'provisional',entryTimeSource:'observed',remainingContracts:contracts,remainingQuantity:contracts!=null&&cv!=null?contracts*cv:null,entryOrderIds:[entryOrderId!],symbol,productId,side,source:'bot',...(trade.strategyConfig?{strategyConfig:trade.strategyConfig}:{}),entryIntentId:trade.entryIntentId??null,protectionState:trade.protectionState??'PENDING',protectionUpdatedAt:new Date(dependencies.now()),attributionStatus:'BOT_CONFIRMED',status:'OPEN',entryTime:trade.openedAt?new Date(trade.openedAt):null,intendedEntryPrice:num(trade.trigger??trade.entryPrice),actualEntryPrice:num(trade.actualEntryPrice),quantity:contracts!=null&&cv!=null?contracts*cv:null,contracts,contractValue:cv,riskAmount:num(trade.riskAmount),takerRate:num(trade.takerRate),gstPct:num(trade.gstPct),initialSL:num(trade.sl),takeProfit:num(trade.tp),exitTime:null,intendedExitPrice:null,actualExitPrice:null,exitReason:'UNKNOWN',grossPnL:null,brokerage:null,GST:null,otherCharges:null,totalCharges:null,netPnL:null,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:null,entryOrderId,exitOrderId:null,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:null,entryFillIds:trade.entryFillIds??[],exitFillIds:[],financialStatus:'unavailable',feeDataSource:null,priceDataSource:null,attributionNote:null,reconciliationError:null,reconciledAt:null});
}

export async function persistOpenManualTrade(trade:ActiveTradeSnapshot,productId:number,symbol:string,entryFills:DeltaFill[],dependencies:TradePersistenceDependencies=defaultDependencies,context?:TradeRuntimeContext){
  if(trade.source!=='exchange_existing'||trade.attributionStatus!=='MANUAL_CONFIRMED')throw new Error('Manual OPEN persistence requires MANUAL_CONFIRMED ownership');
  entryFills=uniqueFills(entryFills);
  const entryFillIds=entryFills.map(fillId).filter((v):v is string=>!!v);const baseTradeId=stableTradeId('exchange_existing',productId,null,entryFillIds,[]);let tradeId=baseTradeId&&context?`${context.environment}:${context.portfolioId}:${baseTradeId}`:baseTradeId;
  if(!tradeId||!entryFillIds.length)throw new Error('Cannot persist manual ownership without stable Delta entry fill identifiers');
  const existing=dependencies.findEntryClaim?await dependencies.findEntryClaim(entryFillIds,tradeId,context?.portfolioId):null;
  if(existing){
    const existingOrders=new Set(existing.entryOrderIds??(existing.entryOrderId?[existing.entryOrderId]:[]));
    if(existing.status==='CLOSED'||existing.attributionStatus!=='MANUAL_CONFIRMED'||existing.productId!==productId||existing.symbol!==symbol||existing.portfolioId!==context?.portfolioId||existing.environment!==context?.environment||!existing.entryFillIds.every(fill=>entryFillIds.includes(fill))||entryFills.some(fill=>!existingOrders.has(String(fill.order_id))))throw new Error('TRADE_HISTORY_ENTRY_FILL_ALREADY_CLAIMED');
    tradeId=existing.tradeId;
  }
  if(context&&dependencies.claimFills)await dependencies.claimFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId,fillIds:entryFillIds,role:'ENTRY'});
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG',remainingContracts=num(trade.ownedContracts??trade.contracts),contracts=entryFills.reduce((sum,fill)=>sum+Math.abs(Number(fill.size)),0),cv=num(trade.contractValue),actualEntryPrice=weightedAverage(entryFills);
  if(actualEntryPrice==null)throw new Error('Cannot persist manual ownership without actual Delta entry prices');
  const entryTimeMs=Math.min(...entryFills.map(f=>deltaTimestampMilliseconds(f.created_at)??Infinity));const entryOrderIds=[...new Set(entryFills.map(f=>id(f.order_id)).filter((v):v is string=>!!v))];const entryOrderId=entryOrderIds.length===1?entryOrderIds[0]:null;const brokerage=aggregateCommission(entryFills);
  const initialSL=num(trade.sl),takeProfit=num(trade.tp);
  await dependencies.upsert({tradeId,...context,entryDataStatus:'provisional',entryTimeSource:'exchange',entryOrderIds,remainingContracts,remainingQuantity:remainingContracts!=null&&cv!=null?remainingContracts*cv:null,symbol,productId,side,source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED',status:'OPEN',protectionState:initialSL!=null||takeProfit!=null?'PENDING':null,protectionUpdatedAt:initialSL!=null||takeProfit!=null?new Date(dependencies.now()):null,entryTime:Number.isFinite(entryTimeMs)?new Date(entryTimeMs):null,intendedEntryPrice:null,actualEntryPrice,quantity:contracts!=null&&cv!=null?contracts*cv:contracts,contracts,contractValue:cv,initialSL,takeProfit,exitTime:null,intendedExitPrice:null,actualExitPrice:null,exitReason:'UNKNOWN',grossPnL:null,brokerage,GST:null,otherCharges:null,totalCharges:null,netPnL:null,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:null,entryOrderId,exitOrderId:null,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:null,entryFillIds,exitFillIds:[],financialStatus:'unavailable',feeDataSource:brokerage!=null?'delta_fills_commission':null,priceDataSource:'delta_weighted_fills',attributionNote:'Manual position adopted from complete Delta opening lifecycle',reconciliationError:null,reconciledAt:null});
  return {tradeId,entryFillIds,entryTime:Number.isFinite(entryTimeMs)?entryTimeMs:null,actualEntryPrice};
}

function exitReason(order:any):TradeExitReason {
  if(order?.stop_order_type==='liquidation_order')return 'LIQUIDATION';
  if(order?.stop_order_type==='stop_loss_order') return 'SL';
  if(order?.stop_order_type==='take_profit_order') return 'TP';
  return order?'MANUAL_CLOSE':'UNKNOWN';
}

export async function persistClosedTrade(trade:ActiveTradeSnapshot, productId:number, symbol:string, observedExitPrice:number|null,dependencies:TradePersistenceDependencies=defaultDependencies,context?:TradeRuntimeContext) {
  const source:TradeSource=trade.source==='bot'?'bot':'exchange_existing';
  if(trade.attributionStatus==='UNKNOWN'||trade.attributionStatus==='LOOKUP_FAILED'||(trade.source!=='bot'&&trade.source!=='exchange_existing')) throw new Error('TRADE_HISTORY_RECONCILIATION_UNRESOLVED: ownership is not confirmed');
  if(trade.positionClosedAt&&trade.tradeId&&context&&!trade.mixedPosition&&dependencies.confirmClose)await dependencies.confirmClose(trade.tradeId,context.portfolioId,new Date(trade.positionClosedAt));
  const side:TradeSide=trade.direction==='short'?'SHORT':'LONG';
  const openedMs=trade.openedAt??trade.adoptedAt??dependencies.now()-24*60*60*1000;
  const startMicros=toDeltaMicroseconds(Math.max(0,openedMs-60_000));
  const [fillsResponse,ordersResponse]=await Promise.all([dependencies.fills(productId,startMicros),dependencies.orders(productId,startMicros)]);
  const fills:DeltaFill[]=Array.isArray(fillsResponse?.result)?uniqueFills(fillsResponse.result):[];
  const orders:any[]=Array.isArray(ordersResponse?.result)?ordersResponse.result:[];
  const entryOrderId=id(trade.orderId);
  let targetContracts=Math.abs(Number(trade.ownedContracts??trade.contracts??0));
  const completedEntry=orders.find(order=>id(order.id)===entryOrderId&&Number(order.product_id)===productId&&['closed','cancelled'].includes(order.state));
  if(source==='bot'&&completedEntry&&fillsResponse.complete){
    const filled=fills.filter(fill=>id(fill.order_id)===entryOrderId&&Number(fill.product_id)===productId).reduce((sum,fill)=>sum+Math.abs(Number(fill.size)),0);
    const reported=num(completedEntry.filled_size??(completedEntry.size!=null&&completedEntry.unfilled_size!=null?Number(completedEntry.size)-Number(completedEntry.unfilled_size):null));
    if(filled>0&&filled<=targetContracts&&(reported==null||reported===filled))targetContracts=filled;
  }
  const windowStart=openedMs-60_000;
  const attribution=attributeTradeFills({source,side,productId,ownedContracts:targetContracts,entryOrderId,entryFillIds:trade.entryFillIds,fills,orders,windowStart,windowEnd:trade.closedAtBoundary??dependencies.now()+5_000,historyComplete:fillsResponse.complete&&ordersResponse.complete,mixedPosition:trade.mixedPosition===true});
  if(!attribution.complete) throw new Error(`TRADE_HISTORY_RECONCILIATION_INCOMPLETE: ${attribution.reason}`);
  const entryFills=attribution.entryFills, exitFills=attribution.exitFills;
  const entryFillIds=entryFills.map(fillId).filter((v):v is string=>!!v), exitFillIds=exitFills.map(fillId).filter((v):v is string=>!!v);
  const resolvedId=stableTradeId(source,productId,entryOrderId,entryFillIds,exitFillIds);
  if(!resolvedId) throw new Error('No stable exchange identity available; refusing timestamp-only trade persistence');
  const tradeId=trade.tradeId??(context?`${context.environment}:${context.portfolioId}:${resolvedId}`:resolvedId);
  if(dependencies.findExitClaim&&await dependencies.findExitClaim(exitFillIds,tradeId,context?.portfolioId))throw new Error('TRADE_HISTORY_EXIT_FILL_ALREADY_CLAIMED');
  if(context&&dependencies.claimFills){await dependencies.claimFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId,fillIds:entryFillIds,role:'ENTRY'});await dependencies.claimFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId,fillIds:exitFillIds,role:'EXIT'});}
  const contracts=targetContracts, cv=num(trade.contractValue), quantity=contracts!=null&&cv!=null?contracts*cv:contracts;
  const actualEntry=weightedAverage(entryFills);
  const actualExit=weightedAverage(exitFills);
  const entryForPnl=actualEntry;
  const exitForPnl=actualExit;
  const estimateEntry=entryForPnl??num(trade.entryPrice), estimateExit=actualExit??num(observedExitPrice);
  const rate=num(trade.takerRate); const estimatedBrokerage=rate!=null&&quantity!=null&&estimateEntry!=null&&estimateExit!=null?quantity*(estimateEntry+estimateExit)*rate:null;
  const gstPct=num(trade.gstPct??config.gstPct); const estimatedGST=estimatedBrokerage!=null&&gstPct!=null?estimatedBrokerage*gstPct/100:null;
  const money=financials({side,entry:entryForPnl,exit:exitForPnl,quantity,entryFills,exitFills,estimatedBrokerage,estimatedGST,manualCommissionIncludesGST:source==='exchange_existing'});
  const exitOrderIds=[...new Set(exitFills.map(f=>id(f.order_id)).filter((v):v is string=>!!v))],exitOrders=exitOrderIds.map(orderId=>orders.find(o=>id(o.id)===orderId)),exitReasons=new Set(exitOrders.map(order=>String(order?.id)===trade.protectionSlOrderId?'SL':String(order?.id)===trade.protectionTpOrderId?'TP':exitReason(order)));
  const provenExitReason:TradeExitReason=exitOrders.every(Boolean)&&exitReasons.size===1?[...exitReasons][0]:'UNKNOWN';
  const exitOrderId=exitOrderIds.length===1?exitOrderIds[0]:null;const exitOrder=exitOrderId?orders.find(o=>id(o.id)===exitOrderId):null;
  const exitAt=exitFills.map(f=>date(f.created_at)).filter((v):v is Date=>!!v).sort((a,b)=>b.valueOf()-a.valueOf())[0]??new Date(dependencies.now());
  const risk=num(trade.riskAmount); const realizedR=source==='bot'&&risk&&money.netPnL!=null?money.netPnL/risk:null;
  const doc:Omit<TradeDocument,'_id'|'createdAt'|'updatedAt'>={tradeId,...context,closeReconciliationPending:false,entryDataStatus:'reconciled',entryTimeSource:entryFills.length?'exchange':'observed',exitTimeSource:exitFills.some(f=>date(f.created_at))?'exchange':'observed',remainingContracts:0,remainingQuantity:0,entryOrderIds:[...new Set(entryFills.map(f=>String(f.order_id)))],exitOrderIds,...entryExecutionMetrics(side,source==='bot'?trade.trigger:null,actualEntry,contracts,cv),symbol,productId,side,source,attributionStatus:source==='bot'?'BOT_CONFIRMED':'MANUAL_CONFIRMED',status:'CLOSED',entryTime:entryFills.map(f=>date(f.created_at)).filter((v):v is Date=>!!v).sort((a,b)=>a.valueOf()-b.valueOf())[0]??(trade.openedAt?new Date(trade.openedAt):null),intendedEntryPrice:source==='bot'?num(trade.trigger):null,actualEntryPrice:actualEntry,quantity,contracts,contractValue:cv,...(source==='bot'?{riskAmount:risk,takerRate:rate,gstPct}:{}),initialSL:num(trade.initialSL??trade.sl),takeProfit:num(trade.takeProfit??trade.tp),exitTime:exitAt,intendedExitPrice:num(observedExitPrice),actualExitPrice:actualExit,exitReason:provenExitReason,...money,realizedR,entryOrderId,exitOrderId,entryClientOrderId:trade.clientOrderId??null,exitClientOrderId:id(exitOrder?.client_order_id),entryFillIds,exitFillIds,reconciledAt:new Date(dependencies.now()),feeDataSource:money.brokerage!=null?'delta_fills_commission':estimatedBrokerage!=null?'configured_rate_estimate':null,priceDataSource:actualEntry!=null&&actualExit!=null?'delta_weighted_fills':actualExit!=null?'partial_delta_fills':'unavailable',attributionNote:attribution.reason,reconciliationError:null};
  if(context)observeRuntime({kind:'event',portfolioId:context.portfolioId,symbol,event:'CLOSED_TRADE_FILL_EVIDENCE',eventType:'TRADE',data:{tradeId,record:doc,entryFills,exitFills}});
  return await dependencies.upsert(doc)??doc;
}


// Extends the existing OPEN lifecycle; no new ownership or entry decisions.
export async function reconcileOpenTradeExecution(trade:ActiveTradeSnapshot,productId:number,position:any,context:TradeRuntimeContext,marginPosition?:any){
  if(!trade.tradeId)return null;
  const record=await findTradeLifecycle(trade.tradeId,context.portfolioId);
  if(!record||record.productId!==productId||record.environment!==context.environment||record.status==='CLOSED')return null;
  const start=toDeltaMicroseconds(Math.max(0,(record.entryTime?.valueOf()??record.createdAt.valueOf())-60_000));
  const [fills,orders]=await Promise.all([getFillsBounded(productId,start),getOrderHistoryBounded(productId,start)]);
  let combined=position;
  // Margined snapshots can lag; never use one with a different current quantity/entry.
  if(marginPosition&&Number(marginPosition.product_id)===productId&&Number(marginPosition.size)===Number(position.size)&&Number(marginPosition.entry_price)===Number(position.entry_price))combined={...marginPosition,...position,margin:marginPosition.margin};
  const patch=openExecutionPatch(record,combined,fills.result,orders.result,fills.complete&&orders.complete);
  if(!patch)return null;
  observeRuntime({kind:'event',portfolioId:context.portfolioId,symbol:record.symbol,event:'EXECUTION_FILL_EVIDENCE',eventType:'TRADE',
    data:{tradeId:record.tradeId,patch,fills:fills.result.filter(fill=>patch.entryFillIds.includes(String(fill.id))||patch.exitFillIds.includes(String(fill.id)))}});
  await claimTradeFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId:record.tradeId,fillIds:patch.entryFillIds,role:'ENTRY'});
  if(patch.exitFillIds.length)await claimTradeFills({environment:context.environment,productId,portfolioId:context.portfolioId,tradeId:record.tradeId,fillIds:patch.exitFillIds,role:'EXIT'});
  return mutateTradeLifecycle(record.tradeId,context.portfolioId,previous=>{
    if(previous.status==='CLOSED')return null;
    const entry=previous.entryDataStatus==='reconciled'?{}:{actualEntryPrice:patch.actualEntryPrice,entryTime:patch.entryTime,entryTimeSource:patch.entryTimeSource,entryDataStatus:patch.entryDataStatus,contracts:patch.contracts,quantity:patch.quantity,entryFillIds:patch.entryFillIds,entryOrderIds:patch.entryOrderIds,entrySlippagePct:patch.entrySlippagePct,entrySlippageAmount:patch.entrySlippageAmount};
    const metrics=exposureMetrics(combined,previous.contractValue,previous.equityAtEntry);
    // A temporary margin-data outage must not erase the last authoritative exposure snapshot.
    const availableMetrics=Object.fromEntries(Object.entries(metrics).filter(([,value])=>value!=null));
    return {...entry,...availableMetrics,exitFillIds:patch.exitFillIds,exitOrderIds:patch.exitOrderIds,exchangePositionId:position.id!=null?String(position.id):previous.exchangePositionId??null,reconciledAt:new Date()};
  });
}

export { openExecutionPatch } from './lifecycle';
