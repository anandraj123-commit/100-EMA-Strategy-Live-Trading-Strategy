import type { PortfolioDocument } from '../../models/Portfolio';
import { explicitPositionSize } from '../runtime/final-preorder';
import { markPortfolioDeleting,markPortfolioDeleted,waitForPortfolioStopped } from './deletion-state';
import { deletePortfolioRuntimeSettings } from '../settings/repository';
import { getEnvironmentOpenOrders,getEnvironmentPosition } from '../delta';
import { readRuntimeActivity,readStatus } from '../state';
import { hasActivePortfolioTrades } from '../trades/repository';
import { getDb } from '../db/mongodb';
// Deletion also blocks confirmed entries whose trade ownership was not persisted.
export async function findDeletionBlockingIntent(portfolioId:string){return (await getDb()).collection('entry_intents').findOne({portfolioId,$or:[{state:{$in:['SUBMITTING','AMBIGUOUS']}},{state:'CONFIRMED',ownershipPersistedAt:null}]});}
import { acquireLease,newLeaseOwner,portfolioEntryLeaseKey,releaseLease,verifyLeaseOwnership,type RuntimeLease } from '../runtime/leases';
export type DeletionDependencies={status:(id:string)=>any;activity:(id:string)=>any;hasActiveTrades:(id:string)=>Promise<boolean>;blockingIntent:(id:string)=>Promise<any>;position:(productId:number,environment:'real'|'demo')=>Promise<any>;openOrders:(productId:number,environment:'real'|'demo')=>Promise<any[]>};
const defaults:DeletionDependencies={status:readStatus,activity:readRuntimeActivity,hasActiveTrades:hasActivePortfolioTrades,blockingIntent:findDeletionBlockingIntent,position:getEnvironmentPosition,openOrders:getEnvironmentOpenOrders};
export async function verifyPortfolioDeletion(portfolio:PortfolioDocument&{_id:NonNullable<PortfolioDocument['_id']>},dependencies:DeletionDependencies=defaults){const id=portfolio._id.toHexString(),status=dependencies.status(id),activity=dependencies.activity(id);if(activity.executionInProgress===true||Number(status.position?.size||0)!==0||status.activeTrade!=null||await dependencies.hasActiveTrades(id))return {ok:false as const,reason:'ACTIVE'};if(await dependencies.blockingIntent(id))return {ok:false as const,reason:'ENTRY_UNRESOLVED'};let position:any,orders:any[];try{[position,orders]=await Promise.all([dependencies.position(portfolio.productId,portfolio.environment),dependencies.openOrders(portfolio.productId,portfolio.environment)]);}catch{return {ok:false as const,reason:'VERIFICATION_FAILED'};}if(explicitPositionSize(position)===null||!Array.isArray(orders))return {ok:false as const,reason:'VERIFICATION_FAILED'};if(explicitPositionSize(position)!==0||orders.length>0)return {ok:false as const,reason:'ACTIVE'};return {ok:true as const};}

export type CoordinatedDeletionDependencies={acquire:(key:string,owner:string,leaseMs:number)=>Promise<RuntimeLease|null>;owns:(lease:RuntimeLease)=>Promise<boolean>;release:(lease:RuntimeLease)=>Promise<unknown>;verify:(portfolio:PortfolioDocument&{_id:NonNullable<PortfolioDocument['_id']>})=>Promise<{ok:true}|{ok:false;reason:string}>;remove:(id:string)=>Promise<boolean>;mark:(portfolio:PortfolioDocument)=>Promise<unknown>;stopped:(id:string)=>Promise<boolean>;removeSettings:(id:string)=>Promise<unknown>;complete:(id:string)=>Promise<unknown>};
const coordinatedDefaults:CoordinatedDeletionDependencies={acquire:(key,owner,leaseMs)=>acquireLease(key,owner,leaseMs),owns:lease=>verifyLeaseOwnership(lease),release:lease=>releaseLease(lease),verify:portfolio=>verifyPortfolioDeletion(portfolio),remove:async()=>false,mark:markPortfolioDeleting,stopped:waitForPortfolioStopped,removeSettings:deletePortfolioRuntimeSettings,complete:markPortfolioDeleted};
export async function deletePortfolioCoordinated(portfolio:PortfolioDocument&{_id:NonNullable<PortfolioDocument['_id']>},remove:(id:string)=>Promise<boolean>,dependencies:Partial<CoordinatedDeletionDependencies>={}){
  const deps={...coordinatedDefaults,...dependencies,remove},id=portfolio._id.toHexString();
  const lease=await deps.acquire(portfolioEntryLeaseKey(id),newLeaseOwner('delete'),90_000);
  if(!lease)return {ok:false as const,reason:'IN_PROGRESS'};
  try{
    const verified=await deps.verify(portfolio);if(!verified.ok)return verified;
    if(!await deps.owns(lease))return {ok:false as const,reason:'IN_PROGRESS'};
    await deps.mark(portfolio);
    if(!await deps.stopped(id))return {ok:false as const,reason:'STOP_FAILED'};
    const finalCheck=await deps.verify(portfolio);if(!finalCheck.ok)return finalCheck;
    if(!await deps.owns(lease))return {ok:false as const,reason:'IN_PROGRESS'};
    // Both deletes are idempotent. The tombstone retains identity after either fails.
    try{await deps.remove(id);await deps.removeSettings(id);await deps.complete(id);}
    catch{return {ok:false as const,reason:'CLEANUP_FAILED'};}
    return {ok:true as const};
  }catch{return {ok:false as const,reason:'VERIFICATION_FAILED'};}
  finally{await deps.release(lease).catch(()=>false);}
}
