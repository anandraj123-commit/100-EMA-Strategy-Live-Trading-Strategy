import { createHash } from 'node:crypto';
import type { IndexDescription } from 'mongodb';
import { getDb } from '../db/mongodb';
import type { RuntimeEventDocument } from '../../models/RuntimeEvent';
export const runtimeEventIndexes:IndexDescription[]=[
  {key:{createdAt:1},name:'runtime_ttl',expireAfterSeconds:604800},
  {key:{portfolioId:1,symbol:1,resolution:1,candleStartTime:1},name:'decision_identity',unique:true,partialFilterExpression:{eventType:'DECISION'}},
  {key:{portfolioId:1,eventKey:1},name:'runtime_event_identity',unique:true,partialFilterExpression:{eventKey:{$type:'string'}}},
  {key:{portfolioId:1,createdAt:-1},name:'runtime_portfolio_time'},
  {key:{portfolioId:1,symbol:1,createdAt:-1},name:'runtime_symbol_time'},
  {key:{eventType:1,createdAt:-1},name:'runtime_type_time'},
  {key:{tradeId:1},name:'runtime_trade',sparse:true},
  {key:{correlationId:1},name:'runtime_correlation',sparse:true},
];
let ready:Promise<void>|undefined;
let indexedDatabase:string|undefined;
export async function runtimeEventsCollection(){
  const db=await getDb();
  const rows=db.collection<RuntimeEventDocument>('runtime_events');
  if(indexedDatabase!==db.databaseName){ready=undefined;indexedDatabase=db.databaseName;}
  ready??=(async()=>{
    await rows.createIndexes(runtimeEventIndexes);
    const actual=await rows.listIndexes().toArray();
    for(const expected of runtimeEventIndexes){
      const found=actual.find(index=>index.name===expected.name);
      if(!found||JSON.stringify(found.key)!==JSON.stringify(expected.key)||
        found.expireAfterSeconds!==expected.expireAfterSeconds||Boolean(found.unique)!==Boolean(expected.unique)||Boolean(found.sparse)!==Boolean(expected.sparse)||
        JSON.stringify(found.partialFilterExpression)!==JSON.stringify(expected.partialFilterExpression))throw new Error('Runtime event index verification failed');
    }
  })().catch(error=>{ready=undefined;throw error;});
  await ready;
  return rows;
}
export type RuntimeWrite={filter:Record<string,any>;update:Record<string,any>|Record<string,any>[];transition?:{streamKey:string;signature:string}};
export async function persistRuntimeWrite(write:RuntimeWrite){
  const rows=await runtimeEventsCollection();
  if(write.transition){
    const {streamKey,signature}=write.transition;
    const previous=await rows.findOne({portfolioId:write.filter.portfolioId,streamKey},{sort:{createdAt:-1,_id:-1},maxTimeMS:2000});
    if(previous?.stateSignature===signature)return;
    const eventKey=createHash('sha256').update(JSON.stringify([streamKey,previous?.eventKey??null,signature])).digest('hex');
    const document=(write.update as Record<string,any>).$setOnInsert;
    write={filter:{portfolioId:write.filter.portfolioId,eventKey},update:{$setOnInsert:{...document,eventKey,streamKey,stateSignature:signature}}};
  }
  try{await rows.updateOne(write.filter,write.update,{upsert:true,maxTimeMS:2000});}
  catch(error:any){if(error?.code!==11000)throw error;await rows.updateOne(write.filter,write.update,{upsert:false,maxTimeMS:2000});}
}
