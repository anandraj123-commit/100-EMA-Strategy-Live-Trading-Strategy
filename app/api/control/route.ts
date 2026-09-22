import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeSettingOverrides,withPortfolioSettingsLock } from '../../../lib/settings/repository';
import { runtimeSettingDefaults } from '../../../lib/settings/definitions';
import { writeControl } from '../../../lib/state';
import { requireApiSession } from '../../../lib/auth/api';
import { resolvePortfolioId } from '../../../lib/portfolio/access';
export async function POST(req:NextRequest){
  const auth = await requireApiSession(req, { admin: true, csrf: true });
  if (!auth.ok) return auth.error;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error:'Invalid JSON' }, { status:400 }); }
  if (!body || typeof body !== 'object' || typeof (body as { running?: unknown }).running !== 'boolean' || Object.keys(body).some((key) => !['running','portfolioId'].includes(key))) {
    return NextResponse.json({ error:'Invalid control action' }, { status:400 });
  }
  const running = (body as { running: boolean }).running;
  const portfolio=await resolvePortfolioId((body as {portfolioId?:unknown}).portfolioId);
  if(!portfolio)return NextResponse.json({error:'Portfolio not found'},{status:404});
  const id=portfolio._id!.toHexString();
  if(!running){writeControl({running:false},id);return NextResponse.json({success:true,running:false});}
  try{return await withPortfolioSettingsLock(id,async assertOwned=>{
    const values={...runtimeSettingDefaults(),...await getRuntimeSettingOverrides(id)};
    if(values.AUTO_TRADE!==true)return NextResponse.json({code:'AUTO_TRADE_OFF',error:'Enable AUTO_TRADE before starting the robot.'},{status:409});
    if(values.VERIFIED!==true)return NextResponse.json({code:'ENVIRONMENT_NOT_VERIFIED',error:'Verify the portfolio settings before starting the robot.'},{status:409});
    await assertOwned();writeControl({running:true},id);
    return NextResponse.json({success:true,running:true});
  });}catch{return NextResponse.json({error:'Unable to verify current portfolio settings. Retry START.'},{status:409});}
}
