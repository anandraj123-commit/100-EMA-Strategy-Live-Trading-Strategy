import { writeRuntimeActivity } from '../state';
import { releaseLease,renewLease,verifyLeaseOwnership,type RuntimeLease } from './leases';
export type EntryLeaseContext={ownershipLost:()=>boolean;assertOwnership:()=>Promise<void>};
export type EntryActivityDependencies={activity:(value:{executionInProgress:boolean},portfolioId:string)=>unknown;release:(lease:RuntimeLease)=>Promise<unknown>;renew?:(lease:RuntimeLease,leaseMs:number)=>Promise<boolean>;verify?:(lease:RuntimeLease)=>Promise<boolean>;setTimer?:(callback:()=>void,ms:number)=>ReturnType<typeof setInterval>;clearTimer?:(timer:ReturnType<typeof setInterval>)=>void};
export type EntryActivityOptions={leaseMs?:number;heartbeatMs?:number;onLeaseLost?:()=>void};
const defaults:Required<Pick<EntryActivityDependencies,'activity'|'release'|'renew'|'verify'|'setTimer'|'clearTimer'>>={activity:writeRuntimeActivity,release:releaseLease,renew:(lease,leaseMs)=>renewLease(lease,leaseMs),verify:lease=>verifyLeaseOwnership(lease),setTimer:(callback,ms)=>setInterval(callback,ms),clearTimer:timer=>clearInterval(timer)};

export async function withExecutionActivity<T>(lease:RuntimeLease,portfolioId:string,task:(context:EntryLeaseContext)=>Promise<T>,dependencies:EntryActivityDependencies=defaults,options:EntryActivityOptions={}){
  const renew=dependencies.renew??defaults.renew,verify=dependencies.verify??defaults.verify,setTimer=dependencies.setTimer??defaults.setTimer,clearTimer=dependencies.clearTimer??defaults.clearTimer;
  const leaseMs=options.leaseMs??90_000,heartbeatMs=options.heartbeatMs??25_000;
  let lost=false,renewing=false,lossReported=false;
  const markLost=()=>{lost=true;if(!lossReported){lossReported=true;options.onLeaseLost?.();}};
  const heartbeat=async()=>{if(lost||renewing)return;renewing=true;try{if(!await renew(lease,leaseMs))markLost();}catch{markLost();}finally{renewing=false;}};
  const context:EntryLeaseContext={ownershipLost:()=>lost,assertOwnership:async()=>{if(lost||!await verify(lease)){markLost();throw new Error('ACCOUNT_ENTRY_LEASE_LOST');}}};
  let timer:ReturnType<typeof setInterval>|null=null,originalError:unknown,activityStarted=false;
  try{activityStarted=true;dependencies.activity({executionInProgress:true},portfolioId);timer=setTimer(()=>void heartbeat(),heartbeatMs);return await task(context);}catch(error){originalError=error;throw error;}
  finally{if(timer!=null)clearTimer(timer);let cleanupError:unknown;if(activityStarted)try{dependencies.activity({executionInProgress:false},portfolioId);}catch(error){cleanupError=error;}try{await dependencies.release(lease);}catch(error){cleanupError??=error;}if(!originalError&&cleanupError)throw cleanupError;}
}
