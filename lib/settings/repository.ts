import { randomUUID } from 'node:crypto';
import { writeControl } from '../state';
import { acquireLease,newLeaseOwner,portfolioEntryLeaseKey,releaseLease,verifyLeaseOwnership } from '../runtime/leases';
import { getDb } from '../db/mongodb';
import type { RuntimeSettingsDocument, RuntimeSettingValue } from '../../models/RuntimeSettings';
import { runtimeSettingDefaults, validateRuntimeSettings } from './definitions';

async function collection(){return (await getDb()).collection<RuntimeSettingsDocument>('runtime_settings');}
const settingsId=(portfolioId?:string)=>portfolioId?`portfolio:${portfolioId}`:'runtime-settings';
export async function createRuntimeSettingsIfMissing(portfolioId:string){
  if(!portfolioId)throw new Error('Portfolio runtime identity is required');
  const {VERIFIED:_approval,...values}=validateRuntimeSettings(runtimeSettingDefaults());
  await (await collection()).updateOne(
    {_id:settingsId(portfolioId)},
    {$setOnInsert:{portfolioId,values,verified:false,updatedAt:new Date()}},
    {upsert:true}
  );
}
export function sanitizeRuntimeSettingOverrides(values:Record<string,RuntimeSettingValue>){
  if(values.RISK_BASE===undefined||values.RISK_BASE==='available')return values;
  const {RISK_BASE:_unsupported,...safe}=values;
  return safe;
}
// VERIFIED is the settings-API name; the authoritative stored field is verified.
export async function getRuntimeSettingsSnapshot(portfolioId?:string):Promise<{values:Record<string,RuntimeSettingValue>;entryRevision:string}>{
  const row=await (await collection()).findOne({_id:settingsId(portfolioId)});
  return {values:{...sanitizeRuntimeSettingOverrides(row?.values??{}),VERIFIED:row?.verified===true},entryRevision:row?.entryRevision??'legacy'};
}
export async function getRuntimeSettingOverrides(portfolioId?:string){return (await getRuntimeSettingsSnapshot(portfolioId)).values;}

// Reuse the existing portfolio entry lease for settings writes and START.
export async function withPortfolioSettingsLock<T>(portfolioId:string,task:(assertOwned:()=>Promise<void>)=>Promise<T>){
  if(!portfolioId)throw new Error('Portfolio runtime identity is required');
  const lease=await acquireLease(portfolioEntryLeaseKey(portfolioId),newLeaseOwner('settings'),30_000);
  if(!lease)throw new Error('Portfolio entry or settings update is in progress.');
  const assertOwned=async()=>{if(!await verifyLeaseOwnership(lease))throw new Error('Portfolio settings lease lost');};
  try{await assertOwned();return await task(assertOwned);}finally{await releaseLease(lease);}
}
export async function saveRuntimeSettingOverrides(input:Record<string,RuntimeSettingValue>,updatedBy:string,portfolioId?:string){
  if(!portfolioId)throw new Error('Portfolio runtime identity is required');
  const supplied=validateRuntimeSettings(input);
  return withPortfolioSettingsLock(portfolioId,async assertOwned=>{
    const previous=await getRuntimeSettingsSnapshot(portfolioId);
    const effective={...runtimeSettingDefaults(),...previous.values};
    const changed=Object.keys(supplied).some(key=>key!=='VERIFIED'&&supplied[key]!==effective[key]);
    const values:Record<string,RuntimeSettingValue>={...previous.values,...supplied,VERIFIED:changed?false:(supplied.VERIFIED??previous.values.VERIFIED)===true};
    const entriesStopped=changed||values.VERIFIED!==true||previous.values.VERIFIED!==true||values.AUTO_TRADE===false;
    const entryRevision=changed||values.VERIFIED!==previous.values.VERIFIED?randomUUID():previous.entryRevision;
    await assertOwned();
    // Stop before publishing. A failed save can leave entries safely stopped,
    // but never publishes changed settings with approval of the old configuration.
    if(entriesStopped)writeControl({running:false},portfolioId);
    const {VERIFIED,...storedValues}=values,verified=VERIFIED===true,updatedAt=new Date();
    await (await collection()).updateOne({_id:settingsId(portfolioId)},{$set:{values:storedValues,verified,entryRevision,updatedAt,updatedBy,portfolioId}}, {upsert:true});
    return {values,verified,entryRevision,updatedAt,updatedBy,entriesStopped};
  });
}
