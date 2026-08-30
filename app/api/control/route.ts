import { NextRequest, NextResponse } from 'next/server';
import { writeControl } from '../../../lib/state';
import { requireApiSession } from '../../../lib/auth/api';
export async function POST(req:NextRequest){
  const auth = await requireApiSession(req, { admin: true, csrf: true });
  if (!auth.ok) return auth.error;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error:'Invalid JSON' }, { status:400 }); }
  if (!body || typeof body !== 'object' || typeof (body as { running?: unknown }).running !== 'boolean' || Object.keys(body).some((key) => key !== 'running')) {
    return NextResponse.json({ error:'Invalid control action' }, { status:400 });
  }
  const running = (body as { running: boolean }).running;
  writeControl({ running });
  return NextResponse.json({success:true,running});
}
