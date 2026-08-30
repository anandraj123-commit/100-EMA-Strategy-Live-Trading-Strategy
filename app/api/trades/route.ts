import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../lib/auth/api';
import { listTrades } from '../../../lib/trades/repository';
import type { TradeSource } from '../../../models/Trade';
export const dynamic='force-dynamic';

export async function GET(req:NextRequest) {
  const auth=await requireApiSession(req); if(!auth.ok) return auth.error;
  const sp=req.nextUrl.searchParams;
  const page=Number(sp.get('page')??1), limit=Number(sp.get('limit')??25), source=sp.get('source'), symbol=sp.get('symbol');
  if(!Number.isInteger(page)||page<1) return NextResponse.json({error:'Invalid page'},{status:400});
  if(!Number.isInteger(limit)||limit<1||limit>100) return NextResponse.json({error:'Invalid limit (1-100)'},{status:400});
  if(source && source!=='bot' && source!=='exchange_existing') return NextResponse.json({error:'Invalid source'},{status:400});
  if(symbol && !/^[A-Z0-9_-]{1,30}$/.test(symbol)) return NextResponse.json({error:'Invalid symbol'},{status:400});
  return NextResponse.json(await listTrades({page,limit,source:source as TradeSource|undefined,symbol:symbol||undefined}));
}
