import path from 'node:path';
import dotenv from 'dotenv';
import { getDb } from '../lib/db/mongodb';
import { backfillClosedManualFinancials } from '../lib/trades/manual-financial-backfill';

dotenv.config({path:path.resolve(process.cwd(),'.env.local'),override:false});

async function main(){
  const mode=process.argv[2];
  if(mode!=='--dry-run'&&mode!=='--apply')throw new Error('Specify exactly one mode: --dry-run or --apply');
  if(process.argv.length!==3)throw new Error('Unexpected arguments; use only --dry-run or --apply');
  const db=await getDb();
  const result=await backfillClosedManualFinancials(db.collection('trades'),mode==='--apply');
  console.log(JSON.stringify({mode:result.mode,database:db.databaseName,collection:'trades',eligibleCount:result.eligibleCount,modifiedCount:result.modifiedCount,trades:result.rows.map(({_id,...row})=>row)},null,2));
}

main().then(()=>process.exit(0)).catch(error=>{console.error(error?.message||String(error));process.exit(1);});
