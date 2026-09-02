import { getDb } from '../db/mongodb';
import type { RuntimeSettingsDocument, RuntimeSettingValue } from '../../models/RuntimeSettings';

async function collection(){return (await getDb()).collection<RuntimeSettingsDocument>('runtime_settings');}
const settingsId=(portfolioId?:string)=>portfolioId?`portfolio:${portfolioId}`:'runtime-settings';
export function sanitizeRuntimeSettingOverrides(values:Record<string,RuntimeSettingValue>){
  if(values.RISK_BASE===undefined||values.RISK_BASE==='available')return values;
  const {RISK_BASE:_unsupported,...safe}=values;
  return safe;
}
export async function getRuntimeSettingOverrides(portfolioId?:string){return sanitizeRuntimeSettingOverrides((await (await collection()).findOne({_id:settingsId(portfolioId)}))?.values??{});}
export async function saveRuntimeSettingOverrides(values:Record<string,RuntimeSettingValue>,updatedBy:string,portfolioId?:string){
  const updatedAt=new Date();
  await (await collection()).updateOne({_id:settingsId(portfolioId)},{$set:{values,updatedAt,updatedBy,...(portfolioId?{portfolioId}:{})}}, {upsert:true});
  return {values,updatedAt,updatedBy};
}
