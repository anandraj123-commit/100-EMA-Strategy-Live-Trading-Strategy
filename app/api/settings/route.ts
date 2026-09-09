import { portfolioEntryAllowed } from '../../../lib/portfolio/deletion-state';
import { acquireLease,newLeaseOwner,portfolioEntryLeaseKey,releaseLease } from '../../../lib/runtime/leases';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../lib/auth/api';
import { runtimeSettingDefaults, runtimeSettingMetadata, validateRuntimeSettings } from '../../../lib/settings/definitions';
import { getRuntimeSettingOverrides, saveRuntimeSettingOverrides } from '../../../lib/settings/repository';
import { resolvePortfolioId } from '../../../lib/portfolio/access';
export const dynamic='force-dynamic';

export async function GET(req:NextRequest){
  const auth=await requireApiSession(req,{admin:true});if(!auth.ok)return auth.error;
  const portfolio=await resolvePortfolioId(req.nextUrl.searchParams.get('portfolioId'));if(!portfolio)return NextResponse.json({error:'Portfolio not found'},{status:404});
  const overrides=await getRuntimeSettingOverrides(portfolio._id!.toHexString());
  return NextResponse.json({values:{...runtimeSettingDefaults(),...overrides},overrides,definitions:runtimeSettingMetadata(),restartRequired:false});
}
export async function PUT(req:NextRequest){
  const auth=await requireApiSession(req,{admin:true,csrf:true});if(!auth.ok)return auth.error;
  let body:unknown;try{body=await req.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
  try{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['values','portfolioId'].includes(key)))throw new Error('Request must contain values and portfolioId');
    const portfolio=await resolvePortfolioId((body as {portfolioId?:unknown}).portfolioId);if(!portfolio)return NextResponse.json({error:'Portfolio not found'},{status:404});
    const values=validateRuntimeSettings((body as {values?:unknown}).values);
    const id=portfolio._id!.toHexString(),lease=await acquireLease(portfolioEntryLeaseKey(id),newLeaseOwner('settings'),30_000);
    if(!lease)return NextResponse.json({error:'Portfolio entry or deletion is in progress.'},{status:409});
    try{
      if(!await portfolioEntryAllowed(id))return NextResponse.json({error:'Portfolio deletion has begun.'},{status:409});
      const saved=await saveRuntimeSettingOverrides(values,auth.session.user.email,id);
      return NextResponse.json({...saved,values:{...runtimeSettingDefaults(),...saved.values},restartRequired:false});
    }finally{await releaseLease(lease);}
  }catch(error:any){return NextResponse.json({error:error?.message||'Invalid settings'},{status:400});}
}
