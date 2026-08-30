import { NextRequest, NextResponse } from 'next/server';
import { requireApiSession } from '../../../../lib/auth/api';
import { clearSessionCookie, invalidateSession } from '../../../../lib/auth/session';

export async function POST(req: NextRequest) {
  const auth = await requireApiSession(req, { csrf: true });
  if (!auth.ok) return auth.error;
  await invalidateSession(auth.session.token);
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  return response;
}
