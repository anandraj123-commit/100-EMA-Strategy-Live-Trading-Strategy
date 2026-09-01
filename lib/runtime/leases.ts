import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongodb';

export type LeaseEnvironment='real'|'demo';
export type RuntimeLease={key:string;ownerId:string;environment?:LeaseEnvironment;acquiredAt:Date;expiresAt:Date};
export type LeaseCollection={findOne(filter:any):Promise<any>;findOneAndUpdate(filter:any,update:any,options:any):Promise<any>;updateOne(filter:any,update:any):Promise<any>;deleteOne(filter:any):Promise<any>};
export type LeaseClock={now():Date};
const systemClock:LeaseClock={now:()=>new Date()};

async function collection(){const rows=(await getDb()).collection('runtime_locks');await rows.createIndex({expiresAt:1},{name:'runtime_lock_expiry'});return rows as unknown as LeaseCollection;}
export const entryLeaseKey=(environment:LeaseEnvironment)=>`delta-account-entry:${environment}`;
export const portfolioLeaseKey=(portfolioId:string)=>`portfolio-runtime:${portfolioId}`;
export const newLeaseOwner=(prefix:string)=>`${prefix}:${randomUUID()}`;

export async function acquireLease(key:string,ownerId:string,leaseMs:number,environment?:LeaseEnvironment,rows?:LeaseCollection,clock:LeaseClock=systemClock){
  const locks=rows??await collection(),now=clock.now(),expiresAt=new Date(now.valueOf()+leaseMs);
  try{
    const result=await locks.findOneAndUpdate({_id:key,$or:[{expiresAt:{$lte:now}},{ownerId}]},{$set:{ownerId,environment,acquiredAt:now,expiresAt}},{upsert:true,returnDocument:'after'});
    const document=result?.value??result;
    return document?.ownerId===ownerId?{key,ownerId,environment,acquiredAt:now,expiresAt}:null;
  }catch(error:any){if(error?.code===11000)return null;throw error;}
}

export async function renewLease(lease:Pick<RuntimeLease,'key'|'ownerId'>,leaseMs:number,rows?:LeaseCollection,clock:LeaseClock=systemClock){const locks=rows??await collection(),now=clock.now(),expiresAt=new Date(now.valueOf()+leaseMs);const result=await locks.updateOne({_id:lease.key,ownerId:lease.ownerId,expiresAt:{$gt:now}},{$set:{expiresAt}});return result.modifiedCount===1;}
export async function verifyLeaseOwnership(lease:Pick<RuntimeLease,'key'|'ownerId'>,rows?:LeaseCollection,clock:LeaseClock=systemClock){const now=clock.now();return Boolean(await (rows??await collection()).findOne({_id:lease.key,ownerId:lease.ownerId,expiresAt:{$gt:now}}));}
export async function releaseLease(lease:Pick<RuntimeLease,'key'|'ownerId'>,rows?:LeaseCollection){const locks=rows??await collection();return (await locks.deleteOne({_id:lease.key,ownerId:lease.ownerId})).deletedCount===1;}

export async function acquireAccountEntryLease(environment:LeaseEnvironment,ownerId:string,options?:{leaseMs?:number;waitMs?:number;retryMs?:number}){const leaseMs=options?.leaseMs??30_000,waitMs=options?.waitMs??1_000,retryMs=options?.retryMs??100;const deadline=Date.now()+waitMs;do{const lease=await acquireLease(entryLeaseKey(environment),ownerId,leaseMs,environment);if(lease)return lease;if(Date.now()>=deadline)return null;await new Promise(resolve=>setTimeout(resolve,retryMs));}while(true);}
