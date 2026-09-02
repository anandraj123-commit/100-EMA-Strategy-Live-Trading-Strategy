import { spawn,type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { PortfolioDocument } from '../../models/Portfolio';
import { acquireLease,newLeaseOwner,portfolioLeaseKey,releaseLease,type RuntimeLease } from './leases';

export type RuntimePortfolio=PortfolioDocument&{_id:NonNullable<PortfolioDocument['_id']>};
export type RuntimeHandle={portfolio:RuntimePortfolio;process:ChildProcess;lease:RuntimeLease};
export type RuntimeSpawner=(portfolio:RuntimePortfolio,lease:RuntimeLease)=>ChildProcess;
export type RuntimeLeaseProvider={acquire(portfolioId:string,ownerId:string):Promise<RuntimeLease|null>;release(lease:RuntimeLease):Promise<unknown>};
export class RuntimePermanentlyDeadError extends Error{constructor(public readonly portfolioId:string){super('Trading runtime repeatedly exited');this.name='RuntimePermanentlyDeadError';}}
export const RECOVERABLE_RUNTIME_EXIT_CODE=75;
export function runtimeStartupExitCode(error:unknown){const value=error as any,name=String(value?.name||''),code=String(value?.code||''),message=String(value?.message||'');if(/runtime identity is required/i.test(message))return 78;if(/configuration not found/i.test(message)||/Mongo(Network|ServerSelection|Timeout)|DELTA_(NETWORK|RATE_LIMITED|SERVER_ERROR)/.test(`${name} ${code}`)||/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|server selection|connection.*timed out/i.test(`${code} ${message}`))return RECOVERABLE_RUNTIME_EXIT_CODE;return 1;}
const mongoLeases:RuntimeLeaseProvider={acquire:(portfolioId,ownerId)=>acquireLease(portfolioLeaseKey(portfolioId),ownerId,30_000),release:lease=>releaseLease(lease)};

export class TradingRuntimeManager{
  readonly instances=new Map<string,RuntimeHandle>();
  private crashTimes=new Map<string,number[]>();
  private intentionalStops=new Set<string>();
  constructor(private readonly loadPortfolios:()=>Promise<PortfolioDocument[]>,private readonly spawnRuntime:RuntimeSpawner,private readonly leases:RuntimeLeaseProvider=mongoLeases){ }
  async synchronize(){
    const cutoff=Date.now()-60_000;for(const [id,times] of this.crashTimes){const recent=times.filter(at=>at>=cutoff);if(recent.length>=3)throw new RuntimePermanentlyDeadError(id);if(recent.length)this.crashTimes.set(id,recent);else this.crashTimes.delete(id);}
    const rows=(await this.loadPortfolios()).filter((row):row is RuntimePortfolio=>!!row._id);
    const configured=new Map(rows.map(row=>[row._id.toHexString(),row]));
    for(const [id,handle] of this.instances){if(!configured.has(id)){this.intentionalStops.add(id);handle.process.kill('SIGTERM');this.instances.delete(id);}}
    for(const [id,portfolio] of configured){if(this.instances.has(id))continue;const lease=await this.leases.acquire(id,newLeaseOwner(`manager:${process.pid}`));if(!lease)continue;const child=this.spawnRuntime(portfolio,lease);this.instances.set(id,{portfolio,process:child,lease});child.once('exit',(code,signal)=>{const intentional=this.intentionalStops.delete(id);if(this.instances.get(id)?.process===child)this.instances.delete(id);if(!intentional&&(signal||(code!=null&&code!==0&&code!==RECOVERABLE_RUNTIME_EXIT_CODE)))this.crashTimes.set(id,[...(this.crashTimes.get(id)??[]),Date.now()]);void this.leases.release(lease);});}
  }
  async stopAll(graceMs=8_000,forceMs=2_000){const handles=[...this.instances.entries()];for(const [id,handle] of handles){this.intentionalStops.add(id);handle.process.kill('SIGTERM');}const wait=(child:ChildProcess,ms:number)=>new Promise<boolean>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve(true);let timer:NodeJS.Timeout;const exited=()=>{clearTimeout(timer);resolve(true);};timer=setTimeout(()=>{child.removeListener('exit',exited);resolve(false);},ms);child.once('exit',exited);});const graceful=await Promise.all(handles.map(([,handle])=>wait(handle.process,graceMs)));for(let index=0;index<handles.length;index++)if(!graceful[index])handles[index][1].process.kill('SIGKILL');const forced=await Promise.all(handles.map(([,handle],index)=>graceful[index]?true:wait(handle.process,forceMs)));this.instances.clear();if(forced.some(exited=>!exited))throw new Error('Portfolio worker did not terminate');}
}

export function spawnPortfolioWorker(portfolio:RuntimePortfolio,lease:RuntimeLease){
  const executable=path.join(process.cwd(),'node_modules','.bin','tsx');
  return spawn(executable,['worker.ts'],{cwd:process.cwd(),env:{...process.env,PORTFOLIO_RUNTIME_ID:portfolio._id.toHexString(),PORTFOLIO_RUNTIME_LEASE_OWNER:lease.ownerId},stdio:'inherit'});
}
