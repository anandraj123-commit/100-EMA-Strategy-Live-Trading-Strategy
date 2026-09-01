import type { Filter } from 'mongodb';
import { getDb } from '../db/mongodb';
import type { EntryIntentDocument } from '../../models/EntryIntent';

let indexesReady:Promise<void>|null=null;
async function collection(){
  const rows=(await getDb()).collection<EntryIntentDocument>('entry_intents');
  indexesReady||=Promise.all([
    rows.createIndex({intentId:1},{unique:true,name:'entry_intent_identity_unique'}),
    rows.createIndex({clientOrderId:1},{unique:true,name:'entry_intent_client_order_unique'}),
    rows.createIndex({portfolioId:1,state:1},{name:'entry_intent_portfolio_state'})
  ]).then(()=>undefined).catch(error=>{indexesReady=null;throw error;});
  await indexesReady;
  return rows;
}

export type PreparedEntryIntent=Omit<EntryIntentDocument,'state'|'deltaOrderId'|'deltaFillIds'|'actualEntryPrice'|'submissionStartedAt'|'confirmedAt'|'ambiguousAt'|'lastReconciledAt'|'ownershipPersistedAt'|'createdAt'|'updatedAt'>;

export async function prepareEntryIntent(intent:PreparedEntryIntent){
  const rows=await collection(),now=new Date();
  try{await rows.updateOne({intentId:intent.intentId},{$setOnInsert:{...intent,state:'PREPARED',deltaOrderId:null,deltaFillIds:[],actualEntryPrice:null,submissionStartedAt:null,confirmedAt:null,ambiguousAt:null,lastReconciledAt:null,ownershipPersistedAt:null,createdAt:now,updatedAt:now}},{upsert:true});}
  catch(error:any){if(error?.code!==11000)throw error;}
  return rows.findOne({intentId:intent.intentId});
}

export async function claimEntrySubmission(intentId:string){const now=new Date();return (await collection()).findOneAndUpdate({intentId,state:'PREPARED'},{$set:{state:'SUBMITTING',submissionStartedAt:now,updatedAt:now}},{returnDocument:'after'});}
export async function resetUntransmittedEntryIntent(intentId:string){const now=new Date();await (await collection()).updateOne({intentId,state:'SUBMITTING'},{$set:{state:'PREPARED',submissionStartedAt:null,updatedAt:now}});}
export async function markEntryIntentAmbiguous(intentId:string){const now=new Date();await (await collection()).updateOne({intentId,state:{$in:['SUBMITTING','AMBIGUOUS']}},{$set:{state:'AMBIGUOUS',ambiguousAt:now,updatedAt:now}});}
export async function markEntryIntentConfirmed(intentId:string,evidence:{deltaOrderId:string;deltaFillIds?:string[];actualEntryPrice?:number|null}){const now=new Date();await (await collection()).updateOne({intentId},{$set:{state:'CONFIRMED',deltaOrderId:evidence.deltaOrderId,deltaFillIds:evidence.deltaFillIds??[],actualEntryPrice:evidence.actualEntryPrice??null,confirmedAt:now,lastReconciledAt:now,updatedAt:now}});return (await collection()).findOne({intentId});}
export async function touchEntryIntentReconciliation(intentId:string){const now=new Date();await (await collection()).updateOne({intentId},{$set:{state:'AMBIGUOUS',lastReconciledAt:now,updatedAt:now}});}
export async function findUnresolvedEntryIntents(portfolioId:string){return (await collection()).find({portfolioId,state:{$in:['SUBMITTING','AMBIGUOUS']}} as Filter<EntryIntentDocument>).sort({createdAt:1}).toArray();}
export async function findBlockingEntryIntent(portfolioId:string){return (await collection()).findOne({portfolioId,state:{$in:['SUBMITTING','AMBIGUOUS']}} as Filter<EntryIntentDocument>,{sort:{createdAt:1}});}
export async function findRecoverableConfirmedEntryIntents(portfolioId:string){return (await collection()).find({portfolioId,state:'CONFIRMED',ownershipPersistedAt:null} as Filter<EntryIntentDocument>).sort({createdAt:1}).toArray();}
export async function markEntryIntentOwnershipPersisted(intentId:string){const now=new Date();await (await collection()).updateOne({intentId,state:'CONFIRMED'},{$set:{ownershipPersistedAt:now,updatedAt:now}});}
