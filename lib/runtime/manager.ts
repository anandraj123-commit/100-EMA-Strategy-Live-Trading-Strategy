import { spawn,type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { PortfolioDocument } from '../../models/Portfolio';
import { acquireLease,newLeaseOwner,portfolioLeaseKey,releaseLease,type RuntimeLease } from './leases';

export type RuntimePortfolio=PortfolioDocument&{_id:NonNullable<PortfolioDocument['_id']>};
export type RuntimeHandle={portfolio:RuntimePortfolio;process:ChildProcess;lease:RuntimeLease};
export type RuntimeSpawner=(portfolio:RuntimePortfolio,lease:RuntimeLease)=>ChildProcess;
export type RuntimeLeaseProvider={acquire(portfolioId:string,ownerId:string):Promise<RuntimeLease|null>;release(lease:RuntimeLease):Promise<unknown>};
const mongoLeases:RuntimeLeaseProvider={acquire:(portfolioId,ownerId)=>acquireLease(portfolioLeaseKey(portfolioId),ownerId,30_000),release:lease=>releaseLease(lease)};

export class TradingRuntimeManager{
  readonly instances=new Map<string,RuntimeHandle>();
  constructor(private readonly loadPortfolios:()=>Promise<PortfolioDocument[]>,private readonly spawnRuntime:RuntimeSpawner,private readonly leases:RuntimeLeaseProvider=mongoLeases){ }
  async synchronize(){
    const rows=(await this.loadPortfolios()).filter((row):row is RuntimePortfolio=>!!row._id);
    const configured=new Map(rows.map(row=>[row._id.toHexString(),row]));
    for(const [id,handle] of this.instances){if(!configured.has(id)){handle.process.kill('SIGTERM');this.instances.delete(id);}}
    for(const [id,portfolio] of configured){if(this.instances.has(id))continue;const lease=await this.leases.acquire(id,newLeaseOwner(`manager:${process.pid}`));if(!lease)continue;const child=this.spawnRuntime(portfolio,lease);this.instances.set(id,{portfolio,process:child,lease});child.once('exit',()=>{if(this.instances.get(id)?.process===child){this.instances.delete(id);void this.leases.release(lease);}});}
  }
  stopAll(){for(const handle of this.instances.values())handle.process.kill('SIGTERM');this.instances.clear();}
}

export function spawnPortfolioWorker(portfolio:RuntimePortfolio,lease:RuntimeLease){
  const executable=path.join(process.cwd(),'node_modules','.bin','tsx');
  return spawn(executable,['worker.ts'],{cwd:process.cwd(),env:{...process.env,PORTFOLIO_RUNTIME_ID:portfolio._id.toHexString(),PORTFOLIO_RUNTIME_LEASE_OWNER:lease.ownerId},stdio:'inherit'});
}
