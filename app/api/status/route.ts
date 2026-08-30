import { NextRequest, NextResponse } from 'next/server';
import { readStatus } from '../../../lib/state';
import { requireApiSession } from '../../../lib/auth/api';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest){
  const auth = await requireApiSession(req);
  if (!auth.ok) return auth.error;
  return NextResponse.json(readStatus());
}
