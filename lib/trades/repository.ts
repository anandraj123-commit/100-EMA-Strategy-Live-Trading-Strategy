import { supportedTriggerMethod, type TriggerMethod } from './protection';
import { randomUUID } from 'node:crypto';
import { mergeTradeLifecycle, protectionPricePatch } from './lifecycle';
import type { Filter } from 'mongodb';
import { getDb } from '../db/mongodb';
import type { TradeDocument, TradeSource } from '../../models/Trade';
import { emptyStats, type TradeStats } from './statistics';

let indexesReady: Promise<void>|null = null;
async function collection() {
  const db = await getDb();
  const trades = db.collection<TradeDocument>('trades');
  indexesReady ||= Promise.all([
    trades.createIndex({ tradeId:1 }, { unique:true, name:'trade_identity_unique' }),
    trades.createIndex({ source:1, exitTime:-1 }, { name:'source_exit_time' }),
    trades.createIndex({ symbol:1, exitTime:-1 }, { name:'symbol_exit_time' }),
    trades.createIndex({ portfolioId:1, exitTime:-1 }, { name:'portfolio_exit_time' }),
    trades.createIndex({ exitTime:-1 }, { name:'exit_time' }),
    trades.createIndex({ createdAt:-1 }, { name:'created_at' })
  ]).then(() => undefined).catch(error => { indexesReady=null; throw error; });
  await indexesReady;
  return trades;
}

// All lifecycle writes use one revision CAS so protection price + history and
// execution reconciliation cannot overwrite each other's audit data.
export async function mutateTradeLifecycle(tradeId:string,portfolioId:string|undefined,mutate:(trade:TradeDocument)=>Partial<TradeDocument>|null) {
  const rows=await collection(),scope={tradeId,...(portfolioId?{portfolioId}:{})};
  for(let attempt=0;attempt<8;attempt++){
    const previous=await rows.findOne(scope);if(!previous)return null;
    const patch=mutate(previous);if(!patch)return previous;
    const revision=previous.lifecycleRevision;
    const result=await rows.updateOne({...scope,lifecycleRevision:revision??{$exists:false}},{$set:{...patch,updatedAt:new Date(),lifecycleRevision:(revision??0)+1}});
    if(result.matchedCount===1)return {...previous,...patch,lifecycleRevision:(revision??0)+1};
  }
  throw new Error('Trade lifecycle concurrently changed; retry reconciliation');
}
export async function upsertTrade(trade: Omit<TradeDocument,'_id'|'createdAt'|'updatedAt'> & Partial<Pick<TradeDocument,'createdAt'|'updatedAt'>>) {
  const rows=await collection(),now=new Date();
  const seed={...trade,createdAt:trade.createdAt??now,updatedAt:now,lifecycleRevision:0,
    currentSL:trade.currentSL??trade.initialSL,currentTarget:trade.currentTarget??trade.takeProfit,
    slHistory:trade.slHistory??[],targetHistory:trade.targetHistory??[]};
  try{await rows.updateOne({tradeId:trade.tradeId},{$setOnInsert:seed},{upsert:true});}catch(error:any){if(error?.code!==11000)throw error;}
  return mutateTradeLifecycle(trade.tradeId,trade.portfolioId,previous=>{
    const {_id,createdAt,lifecycleRevision,...merged}=mergeTradeLifecycle(previous,trade);
    return merged;
  });
}
export async function findTradeLifecycle(tradeId:string,portfolioId:string){return (await collection()).findOne({tradeId,portfolioId});}

export async function listTrades(options:{page:number;limit:number;source?:TradeSource;symbol?:string;portfolioId?:string;environment?:'real'|'demo'}) {
  const trades = await collection();
  const filter:Filter<TradeDocument> = {};
  if (options.source) filter.source=options.source;
  if (options.symbol) filter.symbol=options.symbol;
  if (options.portfolioId) filter.portfolioId=options.portfolioId;
  if (options.environment) filter.environment=options.environment;
  const [rows,total] = await Promise.all([
    trades.find(filter).sort({exitTime:-1,createdAt:-1}).skip((options.page-1)*options.limit).limit(options.limit).toArray(),
    trades.countDocuments(filter)
  ]);
  return {trades:rows.map(({_id,...row})=>({...row,id:_id?.toHexString()})),page:options.page,limit:options.limit,total,totalPages:Math.ceil(total/options.limit)};
}

const sum = (field:string) => ({$sum:{$ifNull:[`$${field}`,0]}});
const scopePipeline = (source?:TradeSource,scope:Record<string,unknown>={}) => [
  {$match:{...scope,status:'CLOSED',source:source??{$in:['bot','exchange_existing']}}},
  {$group:{_id:null,totalTrades:{$sum:1},winningTrades:{$sum:{$cond:[{$gt:['$grossPnL',0]},1,0]}},losingTrades:{$sum:{$cond:[{$lt:['$grossPnL',0]},1,0]}},grossPnL:sum('grossPnL'),brokerage:sum('brokerage'),GST:sum('GST'),otherCharges:sum('otherCharges'),totalCharges:sum('totalCharges'),netPnL:sum('netPnL'),realizedR:sum('realizedR'),realizedRCount:{$sum:{$cond:[{$ne:['$realizedR',null]},1,0]}},grossPnLReportedTrades:{$sum:{$cond:[{$ne:['$grossPnL',null]},1,0]}},fullyReconciledTrades:{$sum:{$cond:[{$ne:['$netPnL',null]},1,0]}},brokerageReportedTrades:{$sum:{$cond:[{$ne:['$brokerage',null]},1,0]}},gstReportedTrades:{$sum:{$cond:[{$ne:['$GST',null]},1,0]}},totalChargesReportedTrades:{$sum:{$cond:[{$ne:['$totalCharges',null]},1,0]}}}},
  {$project:{_id:0,totalTrades:1,winningTrades:1,losingTrades:1,winRate:{$cond:[{$gt:['$grossPnLReportedTrades',0]},{$multiply:[{$divide:['$winningTrades','$grossPnLReportedTrades']},100]},0]},grossPnL:1,brokerage:1,GST:1,otherCharges:1,totalCharges:1,netPnL:1,realizedR:{$cond:[{$gt:['$realizedRCount',0]},'$realizedR',null]},fullyReconciledTrades:1,brokerageReportedTrades:1,gstReportedTrades:1,grossPnLReportedTrades:1,totalChargesReportedTrades:1,grossPnLComplete:{$and:[{$gt:['$totalTrades',0]},{$eq:['$grossPnLReportedTrades','$totalTrades']}]},brokerageComplete:{$and:[{$gt:['$totalTrades',0]},{$eq:['$brokerageReportedTrades','$totalTrades']}]},gstComplete:{$and:[{$gt:['$totalTrades',0]},{$eq:['$gstReportedTrades','$totalTrades']}]},totalChargesComplete:{$and:[{$gt:['$totalTrades',0]},{$eq:['$totalChargesReportedTrades','$totalTrades']}]},netPnLComplete:{$and:[{$gt:['$totalTrades',0]},{$eq:['$fullyReconciledTrades','$totalTrades']}]},winRateBasis:{$literal:'gross_actual'}}}
];

export async function getTradeStats(portfolioId?:string):Promise<{bot:TradeStats;manual:TradeStats;account:TradeStats}> {
  const trades=await collection();
  const scope=portfolioId?{portfolioId}:{};
  const [row] = await trades.aggregate<{bot:TradeStats[];manual:TradeStats[];account:TradeStats[]}>([{$facet:{bot:scopePipeline('bot',scope),manual:scopePipeline('exchange_existing',scope),account:scopePipeline(undefined,scope)}}]).toArray();
  return {bot:row?.bot[0]??emptyStats(),manual:row?.manual[0]??emptyStats(),account:row?.account[0]??emptyStats()};
}

const runtimeScope=(productId:number,portfolioId?:string)=>portfolioId?{productId,portfolioId}:{productId};
export async function findOpenBotTrade(productId:number,portfolioId?:string) {
  return (await collection()).findOne({...runtimeScope(productId,portfolioId),source:'bot',status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>,{sort:{createdAt:-1}});
}

export async function findOpenManualTrade(productId:number,portfolioId?:string){return (await collection()).findOne({...runtimeScope(productId,portfolioId),source:'exchange_existing',status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>,{sort:{createdAt:-1}});}
export async function findOpenManualTrades(productId:number,portfolioId?:string){return (await collection()).find({...runtimeScope(productId,portfolioId),source:'exchange_existing',status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}

export async function findUnresolvedBotTrades(productId:number,portfolioId?:string){return (await collection()).find({...runtimeScope(productId,portfolioId),source:'bot',$or:[{status:{$in:['OPEN','RECONCILING']}},{closeReconciliationPending:true}]} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}
export async function findUnresolvedManualTrades(productId:number,portfolioId?:string){return (await collection()).find({...runtimeScope(productId,portfolioId),source:'exchange_existing',$or:[{status:{$in:['OPEN','RECONCILING']}},{closeReconciliationPending:true}]} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}

export async function hasActivePortfolioTrades(portfolioId:string){return Boolean(await (await collection()).findOne({portfolioId,status:{$ne:'CLOSED'}} as Filter<TradeDocument>,{projection:{_id:1}}));}
export async function findLegacyUnresolvedTrades(productId:number){return (await collection()).find({productId,portfolioId:{$exists:false},status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}

// Only the worker's authoritative zero-position observation may use this fallback.
// Financial/fill reconciliation stays on the existing retry path until exact evidence arrives.
export async function confirmTradePositionClosed(tradeId:string,portfolioId:string,observedAt:Date){
  return mutateTradeLifecycle(tradeId,portfolioId,previous=>{
    if(previous.status==='CLOSED'||!['BOT_CONFIRMED','MANUAL_CONFIRMED'].includes(previous.attributionStatus))return null;
    return {status:'CLOSED',remainingContracts:0,remainingQuantity:0,positionClosedAt:observedAt,
      exitTime:previous.exitTime??observedAt,exitTimeSource:previous.exitTimeSource??'observed',
      closeReconciliationPending:true,reconciliationError:'Position confirmed flat; execution history reconciliation pending'};
  });
}
export async function markTradeReconciling(tradeId:string,error:string){await mutateTradeLifecycle(tradeId,undefined,previous=>previous.status==='CLOSED'?null:{status:'RECONCILING',attributionStatus:'UNKNOWN',reconciliationError:error,attributionNote:error});}
export async function updateTradeProtectionState(tradeId:string,protectionState:NonNullable<TradeDocument['protectionState']>){
  return mutateTradeLifecycle(tradeId,undefined,previous=>{
    if(previous.status==='CLOSED')return null;
    const now=new Date();
    if(protectionState==='PENDING'){
      if(Object.values(previous.protectionSubmissions??{}).some(v=>v?.state==='PENDING'))throw new Error('PREVIOUS_SUBMISSION_NOT_YET_VERIFIED');
      return {protectionState,protectionUpdatedAt:now,protectionSubmissions:{sl:{state:'PENDING',kind:'bracket',clientOrderId:null,orderId:null,submittedAt:now},tp:{state:'PENDING',kind:'bracket',clientOrderId:null,orderId:null,submittedAt:now}}};
    }
    return {protectionState,protectionUpdatedAt:now};
  });
}
export async function synchronizeTradeProtection(tradeId:string,values:{slTriggerMethod?:TriggerMethod;tpTriggerMethod?:TriggerMethod;slClientOrderId?:string|null;tpClientOrderId?:string|null;sl?:number;tp?:number;slOrderId?:string|null;tpOrderId?:string|null;slModifiedAt?:Date;tpModifiedAt?:Date;state?:NonNullable<TradeDocument['protectionState']>},portfolioId?:string){
  return mutateTradeLifecycle(tradeId,portfolioId,previous=>{
    if(previous.status==='CLOSED'||!['BOT_CONFIRMED','MANUAL_CONFIRMED'].includes(previous.attributionStatus))return null;
    const now=new Date(),patch:Partial<TradeDocument>={...protectionPricePatch(previous,values,now),protectionUpdatedAt:now};
    if(values.slOrderId!==undefined)patch.protectionSlOrderId=values.slOrderId;
    if(values.tpOrderId!==undefined)patch.protectionTpOrderId=values.tpOrderId;
    for(const [input,field] of [['slTriggerMethod','currentSLTriggerMethod'],['tpTriggerMethod','currentTargetTriggerMethod']] as const){if(values[input]!==undefined){if(!supportedTriggerMethod(values[input]))throw new Error('Unsupported protection trigger method');patch[field]=values[input];}}
    if(values.slClientOrderId!==undefined)patch.protectionSlClientOrderId=values.slClientOrderId;
    if(values.tpClientOrderId!==undefined)patch.protectionTpClientOrderId=values.tpClientOrderId;
    if(values.state!==undefined)patch.protectionState=values.state;
    const submissions={...previous.protectionSubmissions};
    for(const leg of ['sl','tp'] as const){const orderId=values[leg==='sl'?'slOrderId':'tpOrderId'];if(orderId&&values.state==='ACTIVE'&&submissions[leg])submissions[leg]={...submissions[leg]!,state:'VERIFIED',orderId};}
    patch.protectionSubmissions=submissions;
    return patch;
  });
}
export async function claimProtectionSubmission(tradeId:string,portfolioId:string,legs:('sl'|'tp')[],kind:'bracket'|'stop'|'resize',expected?:{sl:number|null;tp:number|null;contracts:number;slTriggerMethod?:TriggerMethod;tpTriggerMethod?:TriggerMethod}){
  const token=randomUUID().replaceAll('-','').slice(0,20),now=new Date();
  const result=await mutateTradeLifecycle(tradeId,portfolioId,previous=>{
    if(previous.status==='CLOSED'||!['BOT_CONFIRMED','MANUAL_CONFIRMED'].includes(previous.attributionStatus)||legs.some(leg=>previous.protectionSubmissions?.[leg]?.state==='PENDING'))return null;
    if(expected&&((previous.currentSL??previous.initialSL)!==expected.sl||(previous.currentTarget??previous.takeProfit)!==expected.tp||Number(previous.remainingContracts??previous.contracts)!==expected.contracts))return null;
    if(expected&&((expected.slTriggerMethod!==undefined&&previous.currentSLTriggerMethod!==expected.slTriggerMethod)||(expected.tpTriggerMethod!==undefined&&previous.currentTargetTriggerMethod!==expected.tpTriggerMethod)))return null;
    const protectionSubmissions={...previous.protectionSubmissions};
    for(const leg of legs)protectionSubmissions[leg]={state:'PENDING',kind,clientOrderId:`pr-${leg}-${token}`,orderId:previous[leg==='sl'?'protectionSlOrderId':'protectionTpOrderId']??null,submittedAt:now};
    return {protectionSubmissions};
  });
  return result&&legs.every(leg=>result.protectionSubmissions?.[leg]?.clientOrderId===`pr-${leg}-${token}`)?result.protectionSubmissions??null:null;
}
export async function clearTerminalProtectionSubmission(tradeId:string,portfolioId:string,leg:'sl'|'tp',clientOrderId:string|null){
  return mutateTradeLifecycle(tradeId,portfolioId,previous=>{
    const submission=previous.protectionSubmissions?.[leg];
    if(!submission||submission.clientOrderId!==clientOrderId||submission.state!=='PENDING')return null;
    return {protectionSubmissions:{...previous.protectionSubmissions,[leg]:{...submission,state:'TERMINAL'}}};
  });
}


export async function findManualEntryFillClaim(entryFillIds:string[],excludeTradeId?:string,portfolioId?:string){if(!entryFillIds.length)return null;return (await collection()).findOne({...(portfolioId?{portfolioId}:{}),source:'exchange_existing',tradeId:{$ne:excludeTradeId},entryFillIds:{$in:entryFillIds}} as Filter<TradeDocument>);}
export async function findClosedExitFillClaim(exitFillIds:string[],excludeTradeId?:string,portfolioId?:string){if(!exitFillIds.length)return null;return (await collection()).findOne({...(portfolioId?{portfolioId}:{}),status:'CLOSED',tradeId:{$ne:excludeTradeId},exitFillIds:{$in:exitFillIds}} as Filter<TradeDocument>);}
