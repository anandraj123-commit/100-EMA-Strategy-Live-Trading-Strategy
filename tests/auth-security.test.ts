import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import { GET as getStatus } from '../app/api/status/route';
import { POST as postControl } from '../app/api/control/route';
import { getCsrfToken, setSessionCookie, verifyCsrf } from '../lib/auth/session';

process.env.AUTH_SECRET = 'test-only-auth-secret-with-at-least-32-characters';

test('dashboard status rejects an unauthenticated direct request', async () => {
  const response = await getStatus(new NextRequest('http://localhost/api/status'));
  assert.equal(response.status, 401);
});

test('robot control rejects an unauthenticated direct request', async () => {
  const request = new NextRequest('http://localhost/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ running: true }),
  });
  const response = await postControl(request);
  assert.equal(response.status, 401);
});

test('CSRF proof rejects missing, invalid, and cross-origin tokens', () => {
  const sessionToken = 'opaque-test-session-token';
  const csrfToken = getCsrfToken(sessionToken);
  assert.equal(verifyCsrf(new NextRequest('http://localhost/api/control', { method: 'POST' }), sessionToken), false);
  assert.equal(verifyCsrf(new NextRequest('http://localhost/api/control', { method: 'POST', headers: { origin: 'http://localhost', 'x-csrf-token': 'invalid' } }), sessionToken), false);
  assert.equal(verifyCsrf(new NextRequest('http://localhost/api/control', { method: 'POST', headers: { origin: 'https://attacker.invalid', 'x-csrf-token': csrfToken } }), sessionToken), false);
  assert.equal(verifyCsrf(new NextRequest('http://localhost/api/control', { method: 'POST', headers: { origin: 'http://localhost', 'x-csrf-token': csrfToken } }), sessionToken), true);
});

test('production session cookie has required security properties', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true, enumerable: true, writable: true });
  try {
    const response = NextResponse.json({ success: true });
    setSessionCookie(response, 'opaque-token', new Date(Date.now() + 60_000));
    const cookie = response.headers.get('set-cookie') || '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
  } finally {
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else Object.defineProperty(process.env, 'NODE_ENV', { value: previousNodeEnv, configurable: true, enumerable: true, writable: true });
  }
});

const railwayHost = 'trading-platform-production-4df3.up.railway.app';
const railwayOrigin = `https://${railwayHost}`;

test('Railway CSRF uses the pinned public forwarded origin and preserves authentication', async () => {
  const previousDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  process.env.RAILWAY_PUBLIC_DOMAIN = railwayHost;
  try {
    const sessionToken = 'opaque-test-session-token';
    const proof = getCsrfToken(sessionToken);
    const request = (url: string, overrides: Record<string, string> = {}) => new NextRequest(url, {
      method: 'POST',
      headers: { origin: railwayOrigin, 'x-forwarded-proto': 'https', 'x-forwarded-host': railwayHost, 'x-csrf-token': proof, ...overrides },
    });
    for (const url of [`${railwayOrigin}/api/control`, `http://${railwayHost}/api/control`, 'http://internal:3000/api/control']) {
      assert.equal(verifyCsrf(request(url), sessionToken), true);
    }
    assert.equal(verifyCsrf(new NextRequest(`${railwayOrigin}/api/control`, {
      method: 'POST', headers: { origin: railwayOrigin, 'x-csrf-token': proof },
    }), sessionToken), true);
    const withoutProof = request('http://internal:3000/api/control');
    withoutProof.headers.delete('x-csrf-token');
    assert.equal(verifyCsrf(withoutProof, sessionToken), false);
    const internalUrl = 'http://internal:3000/api/control';
    const rejectedHeaders: Record<string, string>[] = [
      { origin: 'https://attacker.invalid' },
      { origin: '' },
      { 'x-csrf-token': '' },
      { 'x-csrf-token': 'invalid' },
      { 'x-csrf-token': getCsrfToken('another-session') },
      { 'x-forwarded-proto': 'http' },
      { 'x-forwarded-proto': 'https,http' },
      { 'x-forwarded-host': `${railwayHost},attacker.invalid` },
      { 'x-forwarded-host': 'attacker.invalid', origin: 'https://attacker.invalid' },
      { 'x-forwarded-host': `${railwayHost}.attacker.invalid` },
      { 'x-forwarded-host': '' },
    ];
    for (const overrides of rejectedHeaders) {
      assert.equal(verifyCsrf(request(internalUrl, overrides), sessionToken), false);
    }
    assert.equal((await postControl(request(internalUrl))).status, 401);
    assert.equal((await getStatus(new NextRequest('http://internal:3000/api/status', {
      headers: { origin: railwayOrigin, 'x-forwarded-proto': 'https', 'x-forwarded-host': railwayHost },
    }))).status, 401);
  } finally {
    if (previousDomain === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
    else process.env.RAILWAY_PUBLIC_DOMAIN = previousDomain;
  }
});

test('outside Railway, localhost works and untrusted forwarded headers do not change the origin', () => {
  const previousDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  try {
    const sessionToken = 'opaque-test-session-token';
    for (const origin of ['http://localhost:3000', railwayOrigin]) {
      const req = new NextRequest('http://localhost:3000/api/control', {
        method: 'POST',
        headers: { origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': railwayHost, 'x-csrf-token': getCsrfToken(sessionToken) },
      });
      assert.equal(verifyCsrf(req, sessionToken), origin === 'http://localhost:3000');
    }
  } finally {
    if (previousDomain !== undefined) process.env.RAILWAY_PUBLIC_DOMAIN = previousDomain;
  }
});
