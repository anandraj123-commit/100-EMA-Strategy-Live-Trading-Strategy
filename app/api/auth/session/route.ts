import { NextRequest, NextResponse } from 'next/server';
import { getCsrfToken, getRequestSession } from '../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getRequestSession(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ user: session.user, csrfToken: getCsrfToken(session.token) });
}
