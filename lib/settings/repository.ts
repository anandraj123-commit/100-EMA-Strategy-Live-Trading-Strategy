import { getDb } from '../db/mongodb';
import type { RuntimeSettingsDocument, RuntimeSettingValue } from '../../models/RuntimeSettings';

async function collection(){return (await getDb()).collection<RuntimeSettingsDocument>('runtime_settings');}
export async function getRuntimeSettingOverrides(){return (await (await collection()).findOne({_id:'runtime-settings'}))?.values??{};}
export async function saveRuntimeSettingOverrides(values:Record<string,RuntimeSettingValue>,updatedBy:string){
  const updatedAt=new Date();
  await (await collection()).updateOne({_id:'runtime-settings'},{$set:{values,updatedAt,updatedBy}}, {upsert:true});
  return {values,updatedAt,updatedBy};
}
