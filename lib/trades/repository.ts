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

export async function upsertTrade(trade: Omit<TradeDocument,'_id'|'createdAt'|'updatedAt'> & Partial<Pick<TradeDocument,'createdAt'|'updatedAt'>>) {
  const trades = await collection();
  const now = new Date();
  const { createdAt, ...fields } = trade;
  await trades.updateOne({ tradeId:trade.tradeId }, { $set:{...fields,updatedAt:now}, $setOnInsert:{createdAt:createdAt??now} }, { upsert:true });
  return trades.findOne({tradeId:trade.tradeId});
}

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

export async function findUnresolvedBotTrades(productId:number,portfolioId?:string){return (await collection()).find({...runtimeScope(productId,portfolioId),source:'bot',status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}
export async function findUnresolvedManualTrades(productId:number,portfolioId?:string){return (await collection()).find({...runtimeScope(productId,portfolioId),source:'exchange_existing',status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}

export async function hasActivePortfolioTrades(portfolioId:string){return Boolean(await (await collection()).findOne({portfolioId,status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>,{projection:{_id:1}}));}
export async function findLegacyUnresolvedTrades(productId:number){return (await collection()).find({productId,portfolioId:{$exists:false},status:{$in:['OPEN','RECONCILING']}} as Filter<TradeDocument>).sort({createdAt:1}).toArray();}

export async function markTradeReconciling(tradeId:string,error:string){const now=new Date();await (await collection()).updateOne({tradeId},{$set:{status:'RECONCILING',attributionStatus:'UNKNOWN',reconciliationError:error,attributionNote:error,updatedAt:now}});}
export async function updateTradeProtectionState(tradeId:string,protectionState:NonNullable<TradeDocument['protectionState']>){const now=new Date();await (await collection()).updateOne({tradeId,source:'bot',status:{$in:['OPEN','RECONCILING']}},{$set:{protectionState,protectionUpdatedAt:now,updatedAt:now}});}
export async function synchronizeTradeProtection(tradeId:string,values:{sl?:number;tp?:number;slOrderId?:string|null;tpOrderId?:string|null;state?:NonNullable<TradeDocument['protectionState']>}){const now=new Date(),set:Record<string,unknown>={protectionUpdatedAt:now,updatedAt:now};if(values.sl!==undefined)set.initialSL=values.sl;if(values.tp!==undefined)set.takeProfit=values.tp;if(values.slOrderId!==undefined)set.protectionSlOrderId=values.slOrderId;if(values.tpOrderId!==undefined)set.protectionTpOrderId=values.tpOrderId;if(values.state!==undefined)set.protectionState=values.state;await (await collection()).updateOne({tradeId,attributionStatus:{$in:['BOT_CONFIRMED','MANUAL_CONFIRMED']},status:{$in:['OPEN','RECONCILING']}},{$set:set});}

export async function findManualEntryFillClaim(entryFillIds:string[],excludeTradeId?:string,portfolioId?:string){if(!entryFillIds.length)return null;return (await collection()).findOne({...(portfolioId?{portfolioId}:{}),source:'exchange_existing',tradeId:{$ne:excludeTradeId},entryFillIds:{$in:entryFillIds}} as Filter<TradeDocument>);}
export async function findClosedExitFillClaim(exitFillIds:string[],excludeTradeId?:string,portfolioId?:string){if(!exitFillIds.length)return null;return (await collection()).findOne({...(portfolioId?{portfolioId}:{}),status:'CLOSED',tradeId:{$ne:excludeTradeId},exitFillIds:{$in:exitFillIds}} as Filter<TradeDocument>);}
