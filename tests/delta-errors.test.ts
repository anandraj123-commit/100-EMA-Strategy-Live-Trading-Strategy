import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaRequestError,classifyDeltaError,deltaErrorDetails } from '../lib/delta';

test('genuine fetch and DNS failures classify network offline',()=>{assert.equal(classifyDeltaError({error:new TypeError('fetch failed')}),'DELTA_NETWORK_OFFLINE');assert.equal(classifyDeltaError({error:Object.assign(new Error('dns'),{code:'ENOTFOUND'})}),'DELTA_NETWORK_OFFLINE');});
test('AbortController failure classifies network timeout',()=>assert.equal(classifyDeltaError({error:Object.assign(new Error('aborted'),{name:'AbortError'})}),'DELTA_NETWORK_TIMEOUT'));
test('HTTP 401 and 403 classify authentication errors',()=>{assert.equal(classifyDeltaError({status:401,payload:{}}),'DELTA_AUTH_ERROR');assert.equal(classifyDeltaError({status:403,payload:{}}),'DELTA_AUTH_ERROR');});
test('reliable signature evidence takes precedence over HTTP auth status',()=>assert.equal(classifyDeltaError({status:401,payload:{error:{code:'signature_mismatch'}}}),'DELTA_SIGNATURE_ERROR'));
test('HTTP 429 classifies rate limiting',()=>assert.equal(classifyDeltaError({status:429,payload:{}}),'DELTA_RATE_LIMITED'));
test('other HTTP 4xx classifies Delta API error',()=>assert.equal(classifyDeltaError({status:400,payload:{}}),'DELTA_API_ERROR'));
test('HTTP 500, 502, and 503 classify Delta server errors',()=>{for(const status of [500,502,503])assert.equal(classifyDeltaError({status,payload:{}}),'DELTA_SERVER_ERROR');});
test('malformed successful payload classifies invalid response',()=>assert.equal(classifyDeltaError({status:200,payload:'not-json'}),'DELTA_INVALID_RESPONSE'));
test('unrecognized failure classifies unknown rather than offline',()=>assert.equal(classifyDeltaError({error:new Error('unexpected')}),'DELTA_UNKNOWN_ERROR'));
test('normalized messages never include credentials or original exception content',()=>{const secret='sensitive-value';const details=deltaErrorDetails(new TypeError(secret));assert.equal(JSON.stringify(details).includes(secret),false);assert.equal(new DeltaRequestError('DELTA_AUTH_ERROR').message.includes(secret),false);});
test('classification preserves fail-closed errors',()=>assert.throws(()=>{throw new DeltaRequestError('DELTA_RATE_LIMITED');},/DELTA_RATE_LIMITED/));
