import type { EntryIntentDocument } from '../../models/EntryIntent';
import { getOrderByClientOrderId } from '../delta';
import { claimEntrySubmission,findUnresolvedEntryIntents,markEntryIntentAmbiguous,markEntryIntentConfirmed,prepareEntryIntent,resetUntransmittedEntryIntent,touchEntryIntentReconciliation,type PreparedEntryIntent } from './repository';

export type EntryIntentDependencies={prepare:typeof prepareEntryIntent;claim:typeof claimEntrySubmission;ambiguous:typeof markEntryIntentAmbiguous;confirmed:typeof markEntryIntentConfirmed;reset?:typeof resetUntransmittedEntryIntent;touch:typeof touchEntryIntentReconciliation;unresolved:typeof findUnresolvedEntryIntents;lookup:typeof getOrderByClientOrderId};
export const entryIntentDependencies:EntryIntentDependencies={prepare:prepareEntryIntent,claim:claimEntrySubmission,ambiguous:markEntryIntentAmbiguous,confirmed:markEntryIntentConfirmed,reset:resetUntransmittedEntryIntent,touch:touchEntryIntentReconciliation,unresolved:findUnresolvedEntryIntents,lookup:getOrderByClientOrderId};
export class EntryNotTransmittedError extends Error{constructor(public readonly reason:string){super(reason);this.name='EntryNotTransmittedError';}}

const matches=(intent:EntryIntentDocument,order:any)=>order&&String(order.client_order_id)===intent.clientOrderId&&Number(order.product_id)===intent.productId;
const evidence=(order:any)=>({deltaOrderId:String(order.id),deltaFillIds:Array.isArray(order.fill_ids)?order.fill_ids.map(String):[],actualEntryPrice:Number.isFinite(Number(order.average_fill_price))?Number(order.average_fill_price):null});

export async function reconcileEntryIntent(intent:EntryIntentDocument,dependencies=entryIntentDependencies){
  try{const order=await dependencies.lookup(intent.clientOrderId);if(matches(intent,order))return dependencies.confirmed(intent.intentId,evidence(order));}
  catch{}
  await dependencies.touch(intent.intentId);
  return null;
}

export async function reconcilePortfolioEntryIntents(portfolioId:string,dependencies=entryIntentDependencies){const intents=await dependencies.unresolved(portfolioId);const confirmed=[];for(const intent of intents){const found=await reconcileEntryIntent(intent,dependencies);if(found)confirmed.push(found);}return {unresolved:intents.length-confirmed.length,confirmed};}

export async function submitPreparedEntryIntent(intent:PreparedEntryIntent,submit:(clientOrderId:string)=>Promise<any>,dependencies=entryIntentDependencies){
  const existing=await dependencies.prepare(intent);
  if(!existing)throw new Error('ENTRY_INTENT_PERSISTENCE_FAILED');
  const claimed=await dependencies.claim(intent.intentId);
  if(!claimed)return {status:'BLOCKED' as const,intent:existing,order:null};
  try{const response=await submit(intent.clientOrderId),order=response?.result;if(!matches(claimed,order))throw new Error('DELTA_ORDER_RESPONSE_IDENTITY_MISMATCH');const confirmed=await dependencies.confirmed(intent.intentId,evidence(order));return {status:'CONFIRMED' as const,intent:confirmed,order:response};}
  catch(error){if(error instanceof EntryNotTransmittedError){await (dependencies.reset??resetUntransmittedEntryIntent)(intent.intentId);return {status:'REJECTED' as const,intent:{...claimed,state:'PREPARED' as const},order:null,error};}await dependencies.ambiguous(intent.intentId);return {status:'AMBIGUOUS' as const,intent:{...claimed,state:'AMBIGUOUS' as const},order:null,error};}
}
