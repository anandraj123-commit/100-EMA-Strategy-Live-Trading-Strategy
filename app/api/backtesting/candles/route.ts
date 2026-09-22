import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../../lib/auth/api';

export const dynamic = 'force-dynamic';

// Transport only: the reference still owns endpoints, retries, pagination and parsing.
export async function GET(req: NextRequest) {
  const auth = await requireApiSession(req, { admin: true });
  if (!auth.ok) return auth.error;
  let upstream: URL;
  try {
    upstream = new URL(req.nextUrl.searchParams.get('upstream') || '');
    if (!['https://api.india.delta.exchange', 'https://api.delta.exchange'].includes(upstream.origin)
      || upstream.pathname !== '/v2/history/candles' || upstream.username || upstream.password || upstream.hash
      || [...upstream.searchParams.keys()].some(key => !['symbol', 'resolution', 'start', 'end'].includes(key))) {
      throw new Error('Invalid candle endpoint');
    }
  } catch {
    return NextResponse.json({ error: 'Invalid candle endpoint' }, { status: 400 });
  }
  try {
    const response = await fetch(upstream.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error' });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Candle transport unavailable' }, { status: 502 });
  }
}
