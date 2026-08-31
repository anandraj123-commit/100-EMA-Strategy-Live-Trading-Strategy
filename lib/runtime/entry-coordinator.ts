import { writeRuntimeActivity } from '../state';
import { releaseLease,type RuntimeLease } from './leases';
export type EntryActivityDependencies={activity:(value:{executionInProgress:boolean},portfolioId:string)=>unknown;release:(lease:RuntimeLease)=>Promise<unknown>};
const defaults:EntryActivityDependencies={activity:writeRuntimeActivity,release:releaseLease};
export async function withExecutionActivity<T>(lease:RuntimeLease,portfolioId:string,task:()=>Promise<T>,dependencies:EntryActivityDependencies=defaults){dependencies.activity({executionInProgress:true},portfolioId);let originalError:unknown;try{return await task();}catch(error){originalError=error;throw error;}finally{let cleanupError:unknown;try{dependencies.activity({executionInProgress:false},portfolioId);}catch(error){cleanupError=error;}try{await dependencies.release(lease);}catch(error){cleanupError??=error;}if(!originalError&&cleanupError)throw cleanupError;}}
