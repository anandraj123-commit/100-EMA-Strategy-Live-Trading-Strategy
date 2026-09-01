import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pendingSetupExpired,type PendingSetup } from '../lib/pending';

const setup=(direction:'long'|'short',candleTime=1_000):PendingSetup=>({direction,trigger:direction==='long'?110:90,sl:direction==='long'?90:110,candleTime});

test('ENTRY_VALID_CANDLES=2 keeps Candle1 and Candle2 valid until the completed-Candle2 boundary',()=>{
  const pending=setup('long'),resolutionSec=300,boundary=pending.candleTime+2*resolutionSec;
  assert.equal(pendingSetupExpired(pending,pending.candleTime+resolutionSec,2,resolutionSec),false);
  assert.equal(pendingSetupExpired(pending,boundary-1,2,resolutionSec),false);
  assert.equal(pendingSetupExpired(pending,boundary,2,resolutionSec),true);
});

test('BUY and SELL pending setups expire identically across resolutions',()=>{
  for(const direction of ['long','short'] as const)for(const resolutionSec of [60,300,900]){
    const pending=setup(direction);
    assert.equal(pendingSetupExpired(pending,pending.candleTime+2*resolutionSec-1,2,resolutionSec),false);
    assert.equal(pendingSetupExpired(pending,pending.candleTime+2*resolutionSec,2,resolutionSec),true);
  }
});

test('AUTO_TRADE transitions neither pause expiry nor reset a valid pending setup age',()=>{
  const pending=setup('long'),originalCandleTime=pending.candleTime,resolutionSec=300;
  let autoTrade=false;
  assert.equal(pendingSetupExpired(pending,pending.candleTime+resolutionSec,2,resolutionSec),false);
  autoTrade=true;
  assert.equal(autoTrade,true);
  assert.equal(pending.candleTime,originalCandleTime);
  assert.equal(pendingSetupExpired(pending,pending.candleTime+2*resolutionSec,2,resolutionSec),true);
});

test('active worker expires pending before breakout evaluation and preserves OFF and Robot Stop order gates',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const expiry=source.indexOf('pendingSetupExpired(pending,latest.time'),breakout=source.indexOf("const breakout = pending.direction");
  assert.ok(expiry>=0&&breakout>expiry);
  assert.match(source,/if \(!reject && config\.autoTrade\)[\s\S]*?await setLeverage[\s\S]*?submitPreparedEntryIntent[\s\S]*?placeMarketOrder/);
  assert.match(source,/if \(!tradingEnabled\) \{\s*pending = null;/);
  assert.match(source,/if \(breakout\)[\s\S]*?if \(!reject && config\.autoTrade\)[\s\S]*?pending = null;/);
});

test('active root config reads ENTRY_VALID_CANDLES with the established default and invalidates pending when it changes live',()=>{
  const config=fs.readFileSync(path.join(process.cwd(),'lib/config.ts'),'utf8');
  const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  assert.match(config,/process\.env\.ENTRY_VALID_CANDLES \|\| 2/);
  assert.match(config,/entryValidCandles/);
  assert.match(worker,/pendingInvalidatingKeys[\s\S]*?pending=null/);
});
