import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../../lib/auth/api';
import { getTradeStats } from '../../../../lib/trades/repository';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest){const auth=await requireApiSession(req);if(!auth.ok)return auth.error;return NextResponse.json(await getTradeStats());}
