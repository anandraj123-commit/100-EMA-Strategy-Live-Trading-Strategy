import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '../db/mongodb';
import type { UserDocument, UserRole } from '../../models/User';
import { getAuthSecret, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from './config';

interface SessionDocument {
  tokenHash: string;
  userId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function csrfForToken(token: string) {
  return crypto.createHmac('sha256', getAuthSecret()).update(`csrf:${token}`).digest('base64url');
}

async function sessionFromToken(token?: string): Promise<{ user: AuthenticatedUser; token: string } | null> {
  if (!token) return null;
  const db = await getDb();
  const session = await db.collection<SessionDocument>('sessions').findOne({
    tokenHash: digest(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await db.collection<UserDocument>('users').findOne({ _id: session.userId });
  if (!user) return null;
  return { user: { id: String(user._id), email: user.email, role: user.role }, token };
}

export async function getRequestSession(req: NextRequest) {
  return sessionFromToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);
}

export async function getServerSession() {
  const cookieStore = await cookies();
  return sessionFromToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function createSession(userId: ObjectId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  const db = await getDb();
  await db.collection<SessionDocument>('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection<SessionDocument>('sessions').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection<SessionDocument>('sessions').insertOne({
    tokenHash: digest(token), userId, createdAt: now, expiresAt,
  });
  return { token, expiresAt };
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date) {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export async function invalidateSession(token?: string) {
  if (!token) return;
  const db = await getDb();
  await db.collection<SessionDocument>('sessions').deleteOne({ tokenHash: digest(token) });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

export function getCsrfToken(sessionToken: string) {
  return csrfForToken(sessionToken);
}

export function verifyCsrf(req: NextRequest, sessionToken: string) {
  const origin = req.headers.get('origin');
  if (!origin || origin !== req.nextUrl.origin) return false;
  const supplied = req.headers.get('x-csrf-token');
  if (!supplied) return false;
  const expected = csrfForToken(sessionToken);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}
