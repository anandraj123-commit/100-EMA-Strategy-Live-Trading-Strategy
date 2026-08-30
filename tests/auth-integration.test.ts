import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';
import { NextRequest } from 'next/server';

const testMongoUri = process.env.AUTH_TEST_MONGODB_URI;

test('MongoDB authentication lifecycle and atomic rate limiting', { skip: !testMongoUri }, async () => {
  const originalCwd = process.cwd();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-integration-'));
  const databaseName = `auth_test_${crypto.randomBytes(8).toString('hex')}`;
  const mongo = new MongoClient(testMongoUri as string);

  process.chdir(temporaryDirectory);
  process.env.MONGODB_URI = testMongoUri;
  process.env.MONGODB_DB = databaseName;
  process.env.AUTH_SECRET = 'integration-test-secret-with-at-least-32-characters';
  process.env.TRUST_PROXY_IP_HEADERS = 'false';

  try {
    await mongo.connect();
    const db = mongo.db(databaseName);
    const adminId = (await db.collection('users').insertOne({
      email: 'admin@example.test',
      passwordHash: await bcrypt.hash('correct-test-password', 4),
      role: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    })).insertedId;

    const loginRoute = await import('../app/api/auth/login/route');
    const logoutRoute = await import('../app/api/auth/logout/route');
    const sessionRoute = await import('../app/api/auth/session/route');
    const statusRoute = await import('../app/api/status/route');
    const controlRoute = await import('../app/api/control/route');
    const sessionModule = await import('../lib/auth/session');
    const rateLimitModule = await import('../lib/auth/rate-limit');

    const requestLogin = (email: string, password: string) => loginRoute.POST(new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }));

    const invalidPassword = await requestLogin('admin@example.test', 'incorrect-password');
    const unknownAccount = await requestLogin('unknown@example.test', 'incorrect-password');
    assert.equal(invalidPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    assert.deepEqual(await invalidPassword.json(), { error: 'Invalid credentials' });
    assert.deepEqual(await unknownAccount.json(), { error: 'Invalid credentials' });

    const login = await requestLogin('admin@example.test', 'correct-test-password');
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /trading_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    const cookie = setCookie.split(';', 1)[0];

    const authenticatedStatus = await statusRoute.GET(new NextRequest('http://localhost/api/status', { headers: { cookie } }));
    assert.equal(authenticatedStatus.status, 200);

    const sessionResponse = await sessionRoute.GET(new NextRequest('http://localhost/api/auth/session', { headers: { cookie } }));
    assert.equal(sessionResponse.status, 200);
    const { csrfToken } = await sessionResponse.json();
    assert.equal(typeof csrfToken, 'string');

    const controlRequest = (token?: string) => new NextRequest('http://localhost/api/control', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
      body: JSON.stringify({ running: true }),
    });
    assert.equal((await controlRoute.POST(controlRequest())).status, 403);
    assert.equal((await controlRoute.POST(controlRequest('invalid'))).status, 403);
    assert.equal((await controlRoute.POST(controlRequest(csrfToken))).status, 200);

    const viewerId = (await db.collection('users').insertOne({
      email: 'viewer@example.test', passwordHash: 'unused', role: 'viewer', createdAt: new Date(), updatedAt: new Date(),
    })).insertedId;
    const viewerSession = await sessionModule.createSession(viewerId);
    const viewerCookie = `trading_session=${viewerSession.token}`;
    const viewerCsrf = sessionModule.getCsrfToken(viewerSession.token);
    const forbidden = await controlRoute.POST(new NextRequest('http://localhost/api/control', {
      method: 'POST',
      headers: { cookie: viewerCookie, origin: 'http://localhost', 'content-type': 'application/json', 'x-csrf-token': viewerCsrf },
      body: JSON.stringify({ running: true }),
    }));
    assert.equal(forbidden.status, 403);

    const logout = await logoutRoute.POST(new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrfToken },
    }));
    assert.equal(logout.status, 200);
    assert.equal((await statusRoute.GET(new NextRequest('http://localhost/api/status', { headers: { cookie } }))).status, 401);

    const expired = await sessionModule.createSession(adminId);
    const expiredHash = crypto.createHash('sha256').update(expired.token).digest('hex');
    await db.collection('sessions').updateOne({ tokenHash: expiredHash }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
    assert.equal((await statusRoute.GET(new NextRequest('http://localhost/api/status', {
      headers: { cookie: `trading_session=${expired.token}` },
    }))).status, 401);

    const attempts = db.collection<{ key: string; attempts: number; expiresAt: Date }>('atomic_test_attempts');
    await attempts.createIndex({ key: 1 }, { unique: true });
    const counts = await Promise.all(Array.from({ length: 20 }, () => rateLimitModule.incrementLoginAttempt(attempts, 'concurrent')));
    assert.deepEqual(counts.sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.equal((await attempts.findOne({ key: 'concurrent' }))?.attempts, 20);

    const limitKeys = rateLimitModule.loginRateLimitKeys(null, 'limited@example.test');
    const decisions = [];
    for (let index = 0; index < 6; index += 1) decisions.push(await rateLimitModule.recordLoginAttempt(limitKeys));
    assert.equal(decisions[4].limited, false);
    assert.equal(decisions[5].limited, true);
  } finally {
    process.chdir(originalCwd);
    await mongo.db(databaseName).dropDatabase().catch(() => undefined);
    await mongo.close().catch(() => undefined);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
