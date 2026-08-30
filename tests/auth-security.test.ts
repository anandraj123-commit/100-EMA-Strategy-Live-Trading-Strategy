import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET as getStatus } from '../app/api/status/route';
import { POST as postControl } from '../app/api/control/route';
import { getCsrfToken, verifyCsrf } from '../lib/auth/session';

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
