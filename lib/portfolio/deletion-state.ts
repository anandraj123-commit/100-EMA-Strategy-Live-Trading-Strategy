import { getDb } from '../db/mongodb';
import type { PortfolioDocument } from '../../models/Portfolio';
import { portfolioLeaseKey } from '../runtime/leases';

type DeletionRecord={_id:string;portfolio:PortfolioDocument;state:'deleting'|'deleted';updatedAt:Date};
async function collection(){return (await getDb()).collection<DeletionRecord>('portfolio_deletions');}
// Retain historical tombstones for entry safety and historical identity lookup.
export async function readPortfolioDeletion(id:string){return (await collection()).findOne({_id:id});}
export async function portfolioEntryAllowed(id:string){return !await readPortfolioDeletion(id);}
export async function waitForPortfolioStopped(id:string,timeoutMs=25_000){
  const locks=(await getDb()).collection('runtime_locks'),deadline=Date.now()+timeoutMs;
  do {
    // Expiry alone is not evidence of shutdown. Require explicit lease release.
    if(!await locks.findOne({_id:portfolioLeaseKey(id)} as any))return true;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  return false;
}
