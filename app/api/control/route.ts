import { NextRequest, NextResponse } from 'next/server';
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
  writeControl({ running },portfolio._id!.toHexString());
  return NextResponse.json({success:true,running});
}
