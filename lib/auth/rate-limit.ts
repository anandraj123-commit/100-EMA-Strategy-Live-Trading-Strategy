import crypto from 'node:crypto';
import type { Collection } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { getDb } from '../db/mongodb';
import { getAuthSecret } from './config';

interface AttemptDocument { key: string; attempts: number; expiresAt: Date }
const WINDOW_MS = 15 * 60 * 1000;

function keyFor(kind: string, value: string) {
  return crypto.createHmac('sha256', getAuthSecret()).update(`${kind}:${value}`).digest('hex');
}

export async function incrementLoginAttempt(attempts: Collection<AttemptDocument>, key: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + WINDOW_MS);
  const update = [{
    $set: {
      key,
      attempts: {
        $cond: [
          { $gt: ['$expiresAt', now] },
          { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
          1,
        ],
      },
      expiresAt: { $cond: [{ $gt: ['$expiresAt', now] }, '$expiresAt', expiresAt] },
    },
  }];

  try {
    const updated = await attempts.findOneAndUpdate({ key }, update, { upsert: true, returnDocument: 'after' });
    if (!updated) throw new Error('Unable to record login attempt');
    return updated.attempts;
  } catch (error) {
    // A unique-key collision is possible only when simultaneous requests create
    // the first counter. Retry as a normal atomic update against the winner.
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const updated = await attempts.findOneAndUpdate({ key }, update, { returnDocument: 'after' });
    if (!updated) throw new Error('Unable to record login attempt');
    return updated.attempts;
  }
}

export function loginRateLimitKeys(source: string | null, email: string) {
  return {
    pair: keyFor('pair', `${source || 'unverified'}:${email}`),
    source: source ? keyFor('source', source) : null,
    account: keyFor('account', email),
  };
}

export async function recordLoginAttempt(keys: ReturnType<typeof loginRateLimitKeys>) {
  const db = await getDb();
  const attempts = db.collection<AttemptDocument>('login_attempts');
  await Promise.all([
    attempts.createIndex({ key: 1 }, { unique: true }),
    attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  const [pair, source, account] = await Promise.all([
    incrementLoginAttempt(attempts, keys.pair),
    keys.source ? incrementLoginAttempt(attempts, keys.source) : Promise.resolve(0),
    incrementLoginAttempt(attempts, keys.account),
  ]);
  return { limited: pair > 5 || source > 30 || account > 10, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
}

export async function clearLoginAttempts(keys: ReturnType<typeof loginRateLimitKeys>) {
  const db = await getDb();
  await db.collection<AttemptDocument>('login_attempts').deleteMany({ key: { $in: Object.values(keys).filter((key): key is string => Boolean(key)) } });
}
