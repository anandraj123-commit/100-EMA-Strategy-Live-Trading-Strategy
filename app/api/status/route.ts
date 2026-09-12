import { getAppMode } from '../../../lib/app-mode';
import { validateStatusMode } from '../../../lib/runtime/status-mode';
import { NextRequest, NextResponse } from 'next/server';
import { readStatus } from '../../../lib/state';
import { requireApiSession } from '../../../lib/auth/api';
import { resolvePortfolioId } from '../../../lib/portfolio/access';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest){
  const auth = await requireApiSession(req);
  if (!auth.ok) return auth.error;
  const portfolio=await resolvePortfolioId(req.nextUrl.searchParams.get('portfolioId'));
  if(!portfolio)return NextResponse.json({error:'Portfolio not found'},{status:404});
  const appMode=getAppMode();
  return NextResponse.json(validateStatusMode(readStatus(portfolio._id!.toHexString()),appMode));
}
