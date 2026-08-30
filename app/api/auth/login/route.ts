import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/mongodb';
import type { UserDocument } from '../../../../models/User';
import { clearLoginAttempts, loginRateLimitKeys, recordLoginAttempt } from '../../../../lib/auth/rate-limit';
import { createSession, setSessionCookie } from '../../../../lib/auth/session';

const DUMMY_HASH = '$2b$12$IYJgIU0FdFI7UIQSuSQgHOJSSoPuLfzTUpk.NXFoZmeJiCfa76wB2';

function trustedRequestSource(req: NextRequest) {
  if (process.env.TRUST_PROXY_IP_HEADERS !== 'true') return null;
  return (req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || '').trim() || null;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 }); }
  const email = typeof (body as { email?: unknown })?.email === 'string' ? (body as { email: string }).email.trim().toLowerCase() : '';
  const password = typeof (body as { password?: unknown })?.password === 'string' ? (body as { password: string }).password : '';
  const source = trustedRequestSource(req);
  const keys = loginRateLimitKeys(source, email || 'invalid');
  const rate = await recordLoginAttempt(keys);
  if (rate.limited) {
    return NextResponse.json({ error: 'Too many login attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } });
  }

  const validShape = email.length > 3 && email.length <= 254 && password.length >= 1 && password.length <= 1024;
  const db = await getDb();
  const user = validShape ? await db.collection<UserDocument>('users').findOne({ email }) : null;
  const passwordValid = await bcrypt.compare(password || 'invalid', user?.passwordHash || DUMMY_HASH);
  if (!user || !passwordValid || user.role !== 'admin' || !user._id) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  await clearLoginAttempts(keys);
  const { token, expiresAt } = await createSession(user._id);
  const response = NextResponse.json({ success: true });
  setSessionCookie(response, token, expiresAt);
  return response;
}
