import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../lib/auth/api';
import { runtimeSettingDefaults, runtimeSettingMetadata, validateRuntimeSettings } from '../../../lib/settings/definitions';
import { getRuntimeSettingOverrides, saveRuntimeSettingOverrides } from '../../../lib/settings/repository';
export const dynamic='force-dynamic';

export async function GET(req:NextRequest){
  const auth=await requireApiSession(req,{admin:true});if(!auth.ok)return auth.error;
  const overrides=await getRuntimeSettingOverrides();
  return NextResponse.json({values:{...runtimeSettingDefaults(),...overrides},overrides,definitions:runtimeSettingMetadata(),restartRequired:true});
}
export async function PUT(req:NextRequest){
  const auth=await requireApiSession(req,{admin:true,csrf:true});if(!auth.ok)return auth.error;
  let body:unknown;try{body=await req.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
  try{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='values'))throw new Error('Request must contain only values');
    const values=validateRuntimeSettings((body as {values?:unknown}).values);
    const saved=await saveRuntimeSettingOverrides(values,auth.session.user.email);
    return NextResponse.json({...saved,values:{...runtimeSettingDefaults(),...saved.values},restartRequired:true});
  }catch(error:any){return NextResponse.json({error:error?.message||'Invalid settings'},{status:400});}
}
