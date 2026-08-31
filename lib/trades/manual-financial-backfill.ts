import type { Filter, ObjectId } from 'mongodb';
import type { TradeDocument } from '../../models/Trade';

export const staleClosedManualFinancialFilter:Filter<TradeDocument>={
  source:'exchange_existing',
  attributionStatus:'MANUAL_CONFIRMED',
  status:'CLOSED',
  grossPnL:{$ne:null},
  brokerage:{$ne:null},
  totalCharges:null,
  netPnL:null,
  financialStatus:{$ne:'actual'}
};

export interface ManualFinancialBackfillRow {
  _id:ObjectId;
  tradeId:string;
  oldBrokerage:number;
  oldGrossPnL:number;
  calculatedTotalCharges:number;
  calculatedNetPnL:number;
  targetFinancialStatus:'actual';
}

interface BackfillCollection {
  find(filter:Filter<TradeDocument>):{toArray():Promise<TradeDocument[]>};
  updateOne(filter:Filter<TradeDocument>,update:{$set:Pick<TradeDocument,'GST'|'totalCharges'|'netPnL'|'realizedR'|'financialStatus'>},options:{upsert:false}):Promise<{modifiedCount:number}>;
}

export function isEligibleStaleClosedManualTrade(trade:TradeDocument):trade is TradeDocument&{_id:ObjectId;grossPnL:number;brokerage:number} {
  return !!trade._id&&trade.source==='exchange_existing'&&trade.attributionStatus==='MANUAL_CONFIRMED'&&trade.status==='CLOSED'&&
    Number.isFinite(trade.grossPnL)&&Number.isFinite(trade.brokerage)&&trade.totalCharges==null&&trade.netPnL==null&&trade.financialStatus!=='actual';
}

export async function backfillClosedManualFinancials(collection:BackfillCollection,apply:boolean) {
  const candidates=await collection.find(staleClosedManualFinancialFilter).toArray();
  const rows:ManualFinancialBackfillRow[]=candidates.filter(isEligibleStaleClosedManualTrade).map(trade=>{
    const additionalFee=Number.isFinite(trade.otherCharges)&&Number(trade.otherCharges)>=0?Number(trade.otherCharges):0;
    const calculatedTotalCharges=trade.brokerage+additionalFee;
    return {_id:trade._id,tradeId:trade.tradeId,oldBrokerage:trade.brokerage,oldGrossPnL:trade.grossPnL,calculatedTotalCharges,calculatedNetPnL:trade.grossPnL-calculatedTotalCharges,targetFinancialStatus:'actual'};
  });
  let modifiedCount=0;
  if(apply)for(const row of rows){
    const result=await collection.updateOne({_id:row._id,...staleClosedManualFinancialFilter},{$set:{GST:null,totalCharges:row.calculatedTotalCharges,netPnL:row.calculatedNetPnL,realizedR:null,financialStatus:'actual'}},{upsert:false});
    modifiedCount+=result.modifiedCount;
  }
  return {mode:apply?'apply' as const:'dry-run' as const,eligibleCount:rows.length,modifiedCount,rows};
}
