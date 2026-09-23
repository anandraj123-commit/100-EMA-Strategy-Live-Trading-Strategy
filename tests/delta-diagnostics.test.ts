import test from 'node:test';
import assert from 'node:assert/strict';
import { publicGet, privateRequest, DeltaRequestError } from '../lib/delta';
import { config } from '../lib/config';

const prefix = '[DELTA REQUEST FAILED] ';
test('Delta request diagnostics preserve behavior and protect credentials', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const expectFailure = async (code: string, request = () => publicGet('/v2/wallet/balances', { token: 'query-credential' })) => {
    logs.length = 0;
    await assert.rejects(request, (error: unknown) => error instanceof DeltaRequestError && error.code === code);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].startsWith(prefix));
    const record = JSON.parse(logs[0].slice(prefix.length));
    assert.equal(record.method, 'GET');
    assert.equal(record.path, '/v2/wallet/balances');
    assert.equal(record.classification, code);
    assert.ok(!logs[0].includes('query-credential'));
    return record;
  };
  for (const [status, code] of [[500,'DELTA_SERVER_ERROR'],[502,'DELTA_SERVER_ERROR'],[503,'DELTA_SERVER_ERROR'],[401,'DELTA_AUTH_ERROR'],[403,'DELTA_AUTH_ERROR'],[429,'DELTA_RATE_LIMITED'],[400,'DELTA_API_ERROR']] as const) {
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({error:{code:'unavailable',message:'Please retry later'},message:'Request failed'}), {status,statusText:'Failure'}));
    const record = await expectFailure(code);
    assert.equal(record.status, status);
    assert.equal(record.statusText, 'Failure');
    assert.equal(record.deltaErrorCode, 'unavailable');
    assert.equal(record.deltaErrorMessage, 'Please retry later');
    assert.equal(record.message, 'Request failed');
  }
  fetchMock.mock.mockImplementation(async () => Response.json({error:{code:'signature_mismatch'}}, {status:401}));
  assert.equal((await expectFailure('DELTA_SIGNATURE_ERROR')).deltaErrorCode, 'signature_mismatch');
  for (const [error, code] of [[new TypeError('secret exception content'),'DELTA_NETWORK_OFFLINE'],[Object.assign(new Error('secret exception content'),{name:'AbortError'}),'DELTA_NETWORK_TIMEOUT']] as const) {
    fetchMock.mock.mockImplementation(async () => { throw error; });
    const record = await expectFailure(code);
    assert.equal(record.status, undefined);
    assert.ok(!logs[0].includes('secret exception content'));
  }
  for (const status of [200, 503]) {
    fetchMock.mock.mockImplementation(async () => new Response('<html>private body</html>', {status}));
    const record = await expectFailure(status === 200 ? 'DELTA_INVALID_RESPONSE' : 'DELTA_SERVER_ERROR');
    assert.equal(record.deltaErrorMessage, undefined);
    assert.ok(!logs[0].includes('private body'));
  }
  const oldKey = config.apiKey, oldSecret = config.apiSecret;
  config.apiKey = 'diagnostic-fixture-key'; config.apiSecret = 'diagnostic-fixture-secret';
  t.after(() => { config.apiKey = oldKey; config.apiSecret = oldSecret; });
  const setEnv = (name: string, value: string) => {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  };
  setEnv('AUTH_SECRET', 'diagnostic-auth-value');
  // Build synthetic credentials at runtime so source scanning stays meaningful.
  const mongoFixture = new URL('mongodb://localhost/db');
  mongoFixture.username = 'fixture';
  mongoFixture.password = 'fixture-password';
  const mongoUri = mongoFixture.toString();
  setEnv('MONGODB_URI', mongoUri);
  setEnv('TELEGRAM_BOT_TOKEN', 'diagnostic-telegram-value');
  setEnv('RAILWAY_API_TOKEN', 'diagnostic-railway-value');
  let signature = '';
  fetchMock.mock.mockImplementation(async (_url, init) => {
    signature = new Headers(init?.headers).get('signature')!;
    return Response.json({error:{code:config.apiKey,message:`${config.apiSecret} ${signature}`},message:`diagnostic-auth-value diagnostic-telegram-value diagnostic-railway-value ${mongoUri}`, arbitrary:'private body'}, {status:503});
  });
  const record = await expectFailure('DELTA_SERVER_ERROR', () => privateRequest('GET','/v2/wallet/balances'));
  assert.equal(record.deltaErrorCode, '[REDACTED]');
  assert.equal(record.deltaErrorMessage, '[REDACTED]');
  assert.equal(record.message, '[REDACTED]');
  for (const value of [config.apiKey, config.apiSecret, signature, mongoUri, 'diagnostic-auth-value','diagnostic-telegram-value','diagnostic-railway-value','private body']) assert.ok(!logs[0].includes(value));
  for (const message of ['Authorization: Bearer unknown-value', 'cookie: unknown-value', 'signature=unknown-value', encodeURIComponent(config.apiSecret)]) {
    fetchMock.mock.mockImplementation(async () => Response.json({message}, {status:503}));
    await expectFailure(message.includes('signature') ? 'DELTA_SIGNATURE_ERROR' : 'DELTA_SERVER_ERROR');
    assert.equal(JSON.parse(logs[0].slice(prefix.length)).message, '[REDACTED]');
  }
  fetchMock.mock.mockImplementation(async () => Response.json({success:true,result:[1,2]}));
  logs.length = 0;
  assert.deepEqual(await publicGet('/v2/products'), {success:true,result:[1,2]});
  assert.deepEqual(logs, []);
});
