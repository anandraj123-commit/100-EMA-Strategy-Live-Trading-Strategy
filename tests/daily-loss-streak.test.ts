import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dailyLossEntryAllowed, dailyLossStreakId, isEligibleDailyLossEvent, recordDailyLossEvent, restoreDailyLossStreak, tradingDayKey, type DailyLossScope, type DailyLossStore } from '../lib/risk/daily-loss-streak';
import type { DailyLossStreakDocument } from '../models/DailyLossStreak';

const at=(day:string)=>new Date(`${day}T12:00:00.000Z`);
const scope=(portfolioId='portfolio-a'):DailyLossScope=>({portfolioId,environment:'demo',productId:7,symbol:'XAUTUSD'});

class MemoryStore implements DailyLossStore {
  documents=new Map<string,DailyLossStreakDocument>();
  writes=0;
  private queue=Promise.resolve();
  failReads=false;

  async findOne(filter:any){if(this.failReads)throw new Error('MongoDB unavailable');return this.documents.get(String(filter._id))??null;}
  async findOneAndUpdate(filter:any,update:any){
    let release!:()=>void;const previous=this.queue;this.queue=new Promise<void>(resolve=>release=resolve);await previous;
    try{
      const id=String(filter._id),existing=this.documents.get(id),eventId=filter.processedEventIds?.$ne;
      if(existing?.processedEventIds.includes(eventId)){const duplicate:any=new Error('duplicate key');duplicate.code=11000;throw duplicate;}
      const row:any=existing?{...existing,processedEventIds:[...existing.processedEventIds]}:{...update.$setOnInsert,consecutiveLosses:0,processedEventIds:[]};
      Object.assign(row,update.$set);
      if(update.$inc)row.consecutiveLosses+=Number(update.$inc.consecutiveLosses||0);
      if(eventId&&!row.processedEventIds.includes(eventId))row.processedEventIds.push(eventId);
      this.documents.set(id,row);this.writes++;
      return row;
    }finally{release();}
  }
}

const loss=(store:MemoryStore,eventId:string,day='2026-09-02',target=scope())=>recordDailyLossEvent({scope:target,eventId,source:'bot',attributionStatus:'BOT_CONFIRMED',outcome:'LOSS',at:at(day)},store);

test('eligible bot loss streak persists across runtime restart',async()=>{const store=new MemoryStore();for(let i=1;i<=8;i++)await loss(store,`trade-${i}`);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,8);});
test('restored limit remains blocked after restart',async()=>{const store=new MemoryStore();for(let i=1;i<=10;i++)await loss(store,`trade-${i}`);const restored=await restoreDailyLossStreak(scope(),at('2026-09-02'),store);assert.equal(dailyLossEntryAllowed(true,restored.consecutiveLosses,10),false);});
test('restart restores N rather than initializing zero',async()=>{const store=new MemoryStore();for(let i=1;i<=4;i++)await loss(store,`trade-${i}`);const restarted=await restoreDailyLossStreak(scope(),at('2026-09-02'),store);assert.equal(restarted.consecutiveLosses,4);assert.notEqual(restarted.consecutiveLosses,0);});
test('next eligible loss increments restored value',async()=>{const store=new MemoryStore();for(let i=1;i<=8;i++)await loss(store,`trade-${i}`);assert.equal((await loss(store,'trade-9')).consecutiveLosses,9);});
test('confirmed bot win reset survives restart',async()=>{const store=new MemoryStore();for(let i=1;i<=8;i++)await loss(store,`trade-${i}`);await recordDailyLossEvent({scope:scope(),eventId:'winning-trade',source:'bot',attributionStatus:'BOT_CONFIRMED',outcome:'WIN',at:at('2026-09-02')},store);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,0);});
test('MANUAL_CONFIRMED loss is excluded',async()=>{const store=new MemoryStore();const result=await recordDailyLossEvent({scope:scope(),eventId:'manual',source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED',outcome:'LOSS',at:at('2026-09-02')},store);assert.equal(result.applied,false);assert.equal(store.writes,0);});
test('exchange_existing never falsely counts as bot loss',()=>{assert.equal(isEligibleDailyLossEvent('exchange_existing','MANUAL_CONFIRMED'),false);});
test('UNKNOWN ownership never falsely counts as bot loss',()=>{assert.equal(isEligibleDailyLossEvent('bot','UNKNOWN'),false);});
test('LOOKUP_FAILED ownership never falsely counts as bot loss',()=>{assert.equal(isEligibleDailyLossEvent('bot','LOOKUP_FAILED'),false);});
test('duplicate close event increments exactly once',async()=>{const store=new MemoryStore();await loss(store,'same-trade');const duplicate=await loss(store,'same-trade');assert.equal(duplicate.applied,false);assert.equal(duplicate.consecutiveLosses,1);assert.equal(store.writes,1);});
test('restart and reconciliation of the same trade remains idempotent',async()=>{const store=new MemoryStore();await loss(store,'reconciled-trade');await restoreDailyLossStreak(scope(),at('2026-09-02'),store);await loss(store,'reconciled-trade');assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,1);});
test('UTC trading-day change starts a separate zero streak without modifying history',async()=>{const store=new MemoryStore();await loss(store,'yesterday','2026-09-01');assert.equal(tradingDayKey(new Date('2026-09-01T23:59:59.999Z')),'2026-09-01');assert.equal(tradingDayKey(new Date('2026-09-02T00:00:00.000Z')),'2026-09-02');assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,0);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-01'),store)).consecutiveLosses,1);});
test('database restoration failure blocks new entries without stopping monitoring loop',async()=>{const store=new MemoryStore();store.failReads=true;await assert.rejects(()=>restoreDailyLossStreak(scope(),at('2026-09-02'),store),/MongoDB unavailable/);assert.equal(dailyLossEntryAllowed(false,0,10),false);const worker=fs.readFileSync(new URL('../worker.ts',import.meta.url),'utf8');assert.match(worker,/DAILY_LOSS_STREAK_RESTORE_FAILED/);assert.match(worker,/while \(true\)[\s\S]*await cycle\(\)/);});
test('portfolio runtime scopes do not contaminate one another',async()=>{const store=new MemoryStore();await loss(store,'a-loss','2026-09-02',scope('portfolio-a'));assert.equal((await restoreDailyLossStreak(scope('portfolio-a'),at('2026-09-02'),store)).consecutiveLosses,1);assert.equal((await restoreDailyLossStreak(scope('portfolio-b'),at('2026-09-02'),store)).consecutiveLosses,0);assert.notEqual(dailyLossStreakId(scope('portfolio-a'),'2026-09-02'),dailyLossStreakId(scope('portfolio-b'),'2026-09-02'));});
test('concurrent unique losses are atomic and concurrent duplicates are idempotent',async()=>{const store=new MemoryStore();await Promise.all([loss(store,'one'),loss(store,'two')]);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,2);await Promise.all([loss(store,'three'),loss(store,'three')]);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,3);});
test('MAX setting changes only the threshold and preserve persisted streak',async()=>{const store=new MemoryStore();for(let i=1;i<=8;i++)await loss(store,`trade-${i}`);const restored=await restoreDailyLossStreak(scope(),at('2026-09-02'),store);assert.equal(restored.consecutiveLosses,8);assert.equal(dailyLossEntryAllowed(true,8,10),true);assert.equal(dailyLossEntryAllowed(true,8,6),false);assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,8);});
test('breakeven and unknown outcomes preserve the existing streak semantics',async()=>{const store=new MemoryStore();await loss(store,'loss');for(const outcome of ['BREAKEVEN','UNKNOWN'] as const){const result=await recordDailyLossEvent({scope:scope(),eventId:`trade-${outcome}`,source:'bot',attributionStatus:'BOT_CONFIRMED',outcome,at:at('2026-09-02')},store);assert.equal(result.applied,false);}assert.equal((await restoreDailyLossStreak(scope(),at('2026-09-02'),store)).consecutiveLosses,1);});
