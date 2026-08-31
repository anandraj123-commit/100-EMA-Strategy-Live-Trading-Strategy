import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../../lib/auth/api';
import { getTradeStats } from '../../../../lib/trades/repository';
import { resolvePortfolioId } from '../../../../lib/portfolio/access';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest){const auth=await requireApiSession(req);if(!auth.ok)return auth.error;const portfolio=await resolvePortfolioId(req.nextUrl.searchParams.get('portfolioId'));if(!portfolio)return NextResponse.json({error:'Portfolio not found'},{status:404});return NextResponse.json(await getTradeStats(portfolio._id!.toHexString()));}
