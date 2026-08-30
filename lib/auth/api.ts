import { NextRequest, NextResponse } from 'next/server';
import { getRequestSession, verifyCsrf } from './session';

export async function requireApiSession(req: NextRequest, options?: { admin?: boolean; csrf?: boolean }) {
  const session = await getRequestSession(req);
  if (!session) return { ok: false, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  if (options?.admin && session.user.role !== 'admin') {
    return { ok: false, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } as const;
  }
  if (options?.csrf && !verifyCsrf(req, session.token)) {
    return { ok: false, error: NextResponse.json({ error: 'Invalid CSRF proof' }, { status: 403 }) } as const;
  }
  return { ok: true, session } as const;
}
