import crypto from 'node:crypto';
import { getDb } from '../db/mongodb';
import { getAuthSecret } from './config';

interface AttemptDocument { key: string; attempts: number; expiresAt: Date }
const WINDOW_MS = 15 * 60 * 1000;

function keyFor(kind: string, value: string) {
  return crypto.createHmac('sha256', getAuthSecret()).update(`${kind}:${value}`).digest('hex');
}

async function increment(key: string) {
  const db = await getDb();
  const attempts = db.collection<AttemptDocument>('login_attempts');
  await attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const now = new Date();
  const existing = await attempts.findOne({ key });
  if (!existing || existing.expiresAt <= now) {
    await attempts.updateOne({ key }, { $set: { attempts: 1, expiresAt: new Date(now.getTime() + WINDOW_MS) } }, { upsert: true });
    return 1;
  }
  await attempts.updateOne({ key }, { $inc: { attempts: 1 } });
  return existing.attempts + 1;
}

export function loginRateLimitKeys(ip: string, email: string) {
  return {
    pair: keyFor('pair', `${ip}:${email}`),
    source: keyFor('source', ip),
    account: keyFor('account', email),
  };
}

export async function recordLoginAttempt(keys: ReturnType<typeof loginRateLimitKeys>) {
  const [pair, source, account] = await Promise.all([increment(keys.pair), increment(keys.source), increment(keys.account)]);
  return { limited: pair > 5 || source > 30 || account > 10, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
}

export async function clearLoginAttempts(keys: ReturnType<typeof loginRateLimitKeys>) {
  const db = await getDb();
  await db.collection<AttemptDocument>('login_attempts').deleteMany({ key: { $in: Object.values(keys) } });
}
