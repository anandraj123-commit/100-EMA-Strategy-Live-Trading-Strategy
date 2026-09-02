import { getDb } from '../db/mongodb';
import type { TradeFillClaimDocument,TradeFillRole } from '../../models/TradeFillClaim';

export type FillIdentity={environment:'real'|'demo';productId:number;fillId:string};
export type FillClaimStore={
  insertOne(document:TradeFillClaimDocument):Promise<unknown>;
  findOne(filter:FillIdentity):Promise<TradeFillClaimDocument|null>;
};
export type HistoricalOwnerLookup=(identity:FillIdentity)=>Promise<string[]>;
export type FillClaimDependencies={store?:FillClaimStore;historicalOwners?:HistoricalOwnerLookup;now?:()=>Date};

let indexesReady:Promise<void>|null=null;
async function collection(){
  const rows=(await getDb()).collection<TradeFillClaimDocument>('trade_fill_claims');
  indexesReady||=Promise.all([
    rows.createIndex({environment:1,productId:1,fillId:1},{unique:true,name:'exchange_fill_identity_unique'}),
    rows.createIndex({tradeId:1},{name:'fill_claim_trade'})
  ]).then(()=>undefined).catch(error=>{indexesReady=null;throw error;});
  await indexesReady;return rows as unknown as FillClaimStore;
}

async function historicalOwners(identity:FillIdentity){
  const trades=(await getDb()).collection('trades');
  const rows=await trades.find({productId:identity.productId,$and:[{$or:[{environment:identity.environment},{environment:{$exists:false}}]},{$or:[{entryFillIds:identity.fillId},{exitFillIds:identity.fillId}]}]},{projection:{tradeId:1}}).limit(3).toArray();
  return [...new Set(rows.map(row=>String(row.tradeId)).filter(Boolean))];
}

export class FillOwnershipConflictError extends Error {
  readonly code='FILL_OWNERSHIP_CONFLICT';
  constructor(readonly identity:FillIdentity,readonly requestedTradeId:string,readonly existingTradeIds:string[]){super(`FILL_OWNERSHIP_CONFLICT: fill ${identity.fillId} is already owned by another trade`);this.name='FillOwnershipConflictError';}
}

export async function claimTradeFills(input:{environment:'real'|'demo';productId:number;portfolioId:string;tradeId:string;fillIds:string[];role:TradeFillRole},dependencies:FillClaimDependencies={}){
  const fillIds=[...new Set(input.fillIds.map(String).map(value=>value.trim()).filter(Boolean))];
  if(!fillIds.length)return [];
  const store=dependencies.store??await collection(),lookup=dependencies.historicalOwners??historicalOwners,createdAt=(dependencies.now??(()=>new Date()))(),results:{fillId:string;status:'CLAIMED'|'ALREADY_OWNED'}[]=[];
  for(const fillId of fillIds){
    const identity={environment:input.environment,productId:input.productId,fillId};
    const historical=[...new Set(await lookup(identity))];
    const otherOwners=historical.filter(owner=>owner!==input.tradeId);
    if(otherOwners.length)throw new FillOwnershipConflictError(identity,input.tradeId,historical);
    try{
      await store.insertOne({...identity,tradeId:input.tradeId,portfolioId:input.portfolioId,role:input.role,createdAt});
      results.push({fillId,status:'CLAIMED'});
    }catch(error:any){
      if(error?.code!==11000)throw error;
      const existing=await store.findOne(identity);
      if(!existing||existing.tradeId!==input.tradeId)throw new FillOwnershipConflictError(identity,input.tradeId,existing?[existing.tradeId]:[]);
      results.push({fillId,status:'ALREADY_OWNED'});
    }
  }
  return results;
}
