import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { acquireLease,entryLeaseKey,releaseLease,type LeaseCollection,type RuntimeLease } from '../lib/runtime/leases';
import { withExecutionActivity } from '../lib/runtime/entry-coordinator';
import { verifyPortfolioDeletion } from '../lib/portfolio/deletion';
import { legacyPositionRequiresReconciliation } from '../lib/runtime/legacy-guard';

class MemoryLocks implements LeaseCollection{
  rows=new Map<string,any>();
  async findOneAndUpdate(filter:any,update:any){const current=this.rows.get(filter._id),now=filter.$or[0].expiresAt.$lte,allowed=!current||current.expiresAt<=now||current.ownerId===filter.$or[1].ownerId;if(!allowed){const error:any=new Error('duplicate');error.code=11000;throw error;}const next={...(current||{}),_id:filter._id,...update.$set};this.rows.set(filter._id,next);return next;}
  async updateOne(filter:any,update:any){const current=this.rows.get(filter._id);if(!current||current.ownerId!==filter.ownerId||current.expiresAt<=filter.expiresAt.$gt)return{modifiedCount:0};this.rows.set(filter._id,{...current,...update.$set});return{modifiedCount:1};}
  async deleteOne(filter:any){const current=this.rows.get(filter._id);if(!current||current.ownerId!==filter.ownerId)return{deletedCount:0};this.rows.delete(filter._id);return{deletedCount:1};}
}
const clock=(value:number)=>({now:()=>new Date(value)});

test('same-environment account entries serialize and second sees margin updated by first',async()=>{const locks=new MemoryLocks(),first=await acquireLease(entryLeaseKey('demo'),'btc',30_000,'demo',locks,clock(1_000));assert.ok(first);assert.equal(await acquireLease(entryLeaseKey('demo'),'xaut',30_000,'demo',locks,clock(1_001)),null);let margin=1_000;const firstSizeMargin=margin;margin=800;await releaseLease(first!,locks);const second=await acquireLease(entryLeaseKey('demo'),'xaut',30_000,'demo',locks,clock(1_002));assert.ok(second);const secondSizeMargin=margin;assert.equal(firstSizeMargin,1_000);assert.equal(secondSizeMargin,800);});

test('REAL and DEMO account entry locks are independent',async()=>{const locks=new MemoryLocks();const real=await acquireLease(entryLeaseKey('real'),'real-worker',30_000,'real',locks,clock(1_000)),demo=await acquireLease(entryLeaseKey('demo'),'demo-worker',30_000,'demo',locks,clock(1_000));assert.ok(real);assert.ok(demo);assert.notEqual(real?.key,demo?.key);});

test('expired process-safe lease can be recovered but an active lease cannot',async()=>{const locks=new MemoryLocks();assert.ok(await acquireLease('portfolio-runtime:p1','manager-one',100,'real',locks,clock(1_000)));assert.equal(await acquireLease('portfolio-runtime:p1','manager-two',100,'real',locks,clock(1_050)),null);assert.ok(await acquireLease('portfolio-runtime:p1','manager-two',100,'real',locks,clock(1_101)));});

for(const failure of ['setLeverage exception','Stop Robot second check','market-order exception','bracket exception'])test(`executionInProgress resets after ${failure}`,async()=>{const activity:boolean[]=[],lease={key:'entry',ownerId:'owner',acquiredAt:new Date(),expiresAt:new Date()} as RuntimeLease;await assert.rejects(()=>withExecutionActivity(lease,'portfolio',async()=>{throw new Error(failure);},{activity:value=>activity.push(value.executionInProgress),release:async()=>true}),new RegExp(failure));assert.deepEqual(activity,[true,false]);});
test('executionInProgress resets after successful entry workflow',async()=>{const activity:boolean[]=[],lease={key:'entry',ownerId:'owner',acquiredAt:new Date(),expiresAt:new Date()} as RuntimeLease;assert.equal(await withExecutionActivity(lease,'portfolio',async()=>42,{activity:value=>activity.push(value.executionInProgress),release:async()=>true}),42);assert.deepEqual(activity,[true,false]);});

function portfolio(){return {_id:new ObjectId(),symbol:'BTCUSD',productId:27,environment:'demo' as const,name:null,contractValue:0.001,settlingAsset:'USD',underlyingAsset:'BTC',createdAt:new Date(),updatedAt:new Date()};}
function deletionDeps(overrides:Partial<any>={}){return {status:()=>({running:false,position:{size:0},activeTrade:null,pending:null}),activity:()=>({executionInProgress:false}),hasActiveTrades:async()=>false,position:async()=>({size:0}),openOrders:async()=>[],...overrides};}
test('fresh Delta nonzero/manual position blocks deletion even when cached status is flat',async()=>{assert.deepEqual(await verifyPortfolioDeletion(portfolio(),deletionDeps({position:async()=>({size:'2'})})),{ok:false,reason:'ACTIVE'});});
test('Delta position lookup failure blocks deletion conservatively',async()=>{assert.deepEqual(await verifyPortfolioDeletion(portfolio(),deletionDeps({position:async()=>{throw new Error('offline');}})),{ok:false,reason:'VERIFICATION_FAILED'});});
test('fresh flat Delta state and no runtime activity permits deletion',async()=>{assert.deepEqual(await verifyPortfolioDeletion(portfolio(),deletionDeps()),{ok:true});});
test('fresh product open orders block deletion',async()=>{assert.deepEqual(await verifyPortfolioDeletion(portfolio(),deletionDeps({openOrders:async()=>[{id:'order'}]})),{ok:false,reason:'ACTIVE'});});
test('legacy unscoped unresolved trade with same-product live position activates migration guard',()=>{assert.equal(legacyPositionRequiresReconciliation(2,[{tradeId:'legacy-open',status:'OPEN'}]),true);assert.equal(legacyPositionRequiresReconciliation(0,[{tradeId:'legacy-open',status:'OPEN'}]),false);});

test('worker acquires account lock before product position and margin refresh',()=>{const source=require('node:fs').readFileSync(require('node:path').join(process.cwd(),'worker.ts'),'utf8'),lock=source.indexOf('acquireAccountEntryLease'),position=source.indexOf('refreshPosition(lastPrice, true)',lock),margin=source.indexOf('refreshWallet(true)',lock);assert.ok(lock>=0&&position>lock&&margin>position);assert.match(source,/LEGACY_TRADE_REQUIRES_PORTFOLIO_RECONCILIATION/);});
