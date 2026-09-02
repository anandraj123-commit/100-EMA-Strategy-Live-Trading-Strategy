import { getDb } from '../db/mongodb';
import type { AttributionStatus, TradeSource } from '../../models/Trade';
import type { DailyLossStreakDocument } from '../../models/DailyLossStreak';
import type { BotExitOutcome } from '../trades/reconciliation';

export type DailyLossScope={portfolioId:string;environment:'real'|'demo';productId:number;symbol:string};
export type DailyLossStore={
  findOne(filter:Record<string,unknown>):Promise<DailyLossStreakDocument|null>;
  findOneAndUpdate(filter:Record<string,unknown>,update:Record<string,unknown>,options:Record<string,unknown>):Promise<DailyLossStreakDocument|{value:DailyLossStreakDocument|null}|null>;
};

async function collection(){return (await getDb()).collection<DailyLossStreakDocument>('daily_loss_streaks') as unknown as DailyLossStore;}
export function tradingDayKey(at:Date=new Date()){return at.toISOString().slice(0,10);}
export function dailyLossStreakId(scope:DailyLossScope,day=tradingDayKey()){return `portfolio:${scope.portfolioId}:day:${day}`;}
export function isEligibleDailyLossEvent(source:TradeSource,attributionStatus:AttributionStatus){return source==='bot'&&attributionStatus==='BOT_CONFIRMED';}
export function dailyLossEntryAllowed(stateReady:boolean,consecutiveLosses:number,maximum:number){return stateReady&&consecutiveLosses<maximum;}

export async function restoreDailyLossStreak(scope:DailyLossScope,at:Date=new Date(),store?:DailyLossStore){
  const tradingDay=tradingDayKey(at),row=await (store??await collection()).findOne({_id:dailyLossStreakId(scope,tradingDay)});
  return {tradingDay,consecutiveLosses:Math.max(0,Math.floor(Number(row?.consecutiveLosses??0)))};
}

export async function recordDailyLossEvent(input:{scope:DailyLossScope;eventId:string;source:TradeSource;attributionStatus:AttributionStatus;outcome:BotExitOutcome;at?:Date},store?:DailyLossStore){
  if(!isEligibleDailyLossEvent(input.source,input.attributionStatus)||!['WIN','LOSS'].includes(input.outcome))return {applied:false,tradingDay:tradingDayKey(input.at),consecutiveLosses:null};
  const eventId=input.eventId.trim();if(!eventId)throw new Error('A stable bot trade identity is required for daily-loss idempotency');
  const rows=store??await collection(),now=input.at??new Date(),tradingDay=tradingDayKey(now),_id=dailyLossStreakId(input.scope,tradingDay);
  const base={_id,...input.scope,tradingDay,createdAt:now};
  const update:any={
    $setOnInsert:base,
    $set:{updatedAt:now,lastProcessedEventId:eventId},
    $addToSet:{processedEventIds:eventId}
  };
  if(input.outcome==='LOSS')update.$inc={consecutiveLosses:1};else update.$set.consecutiveLosses=0;
  try{
    const result=await rows.findOneAndUpdate({_id,processedEventIds:{$ne:eventId}},update,{upsert:true,returnDocument:'after'});
    const row=result&&'value'in result?result.value:result;
    if(row)return {applied:true,tradingDay,consecutiveLosses:Math.max(0,Math.floor(Number(row.consecutiveLosses??0)))};
  }catch(error:any){if(error?.code!==11000)throw error;}
  const existing=await rows.findOne({_id});
  if(!existing)throw new Error('Daily loss streak update did not return durable state');
  return {applied:false,tradingDay,consecutiveLosses:Math.max(0,Math.floor(Number(existing.consecutiveLosses??0)))};
}
