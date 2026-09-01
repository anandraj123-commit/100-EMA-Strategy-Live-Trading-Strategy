import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { changedRuntimeSettings,pendingInvalidatingKeys,runtimeSettingsRevision,strategyStateKeys } from '../lib/settings/live';

test('runtime setting snapshots detect one atomic transition and remain stable on repeated polls',()=>{
  const oldSettings={RESOLUTION:'1m',EMA_LENGTH:100,RR:8,AUTO_TRADE:false};
  const newSettings={RESOLUTION:'5m',EMA_LENGTH:200,RR:5,AUTO_TRADE:false};
  assert.deepEqual(changedRuntimeSettings(oldSettings,newSettings),['EMA_LENGTH','RESOLUTION','RR']);
  assert.deepEqual(changedRuntimeSettings(newSettings,{...newSettings}),[]);
  assert.notEqual(runtimeSettingsRevision(oldSettings),runtimeSettingsRevision(newSettings));
});

test('strategy, risk and execution changes invalidate pending while AUTO_TRADE and POLL_MS retain it',()=>{
  for(const key of ['RESOLUTION','EMA_LENGTH','SLOPE_LOOKBACK','ENTRY_VALID_CANDLES']){assert.equal(strategyStateKeys.has(key),true);assert.equal(pendingInvalidatingKeys.has(key),true);}
  for(const key of ['RR','RISK_PCT','RISK_BASE','MIN_STOP_PCT','MAX_EFFECTIVE_LEVERAGE','MAX_FEE_RISK_PCT','GST_PCT','ORDER_LEVERAGE','PRICE_SOURCE'])assert.equal(pendingInvalidatingKeys.has(key),true);
  assert.equal(pendingInvalidatingKeys.has('AUTO_TRADE'),false);
  assert.equal(pendingInvalidatingKeys.has('POLL_MS'),false);
});

test('worker atomically rebuilds strategy state and checks config generation inside the existing entry path',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const transition=source.indexOf('async function refreshRuntimeSettings'),clear=source.indexOf('completedCandles=[]',transition),apply=source.indexOf('applyRuntimeConfigOverrides(next)',transition);
  assert.ok(transition>=0&&clear>transition&&apply>clear);
  assert.match(source,/pending\.configRevision===configRevision/);
  assert.match(source,/await refreshRuntimeSettings\(\)[\s\S]*?entryConfigRevision!==configRevision[\s\S]*?await setLeverage[\s\S]*?submitPreparedEntryIntent[\s\S]*?placeMarketOrder/);
  assert.match(source,/await setLeverage[\s\S]*?await refreshRuntimeSettings\(\)[\s\S]*?!config\.autoTrade[\s\S]*?!readControl\(portfolioId\)\.running[\s\S]*?submitPreparedEntryIntent[\s\S]*?placeMarketOrder/);
  assert.match(source,/strategyStateReady && tradingEnabled && !blockingEntryIntent && pending/);
  assert.match(source,/PENDING_CANCELLED_CONFIG_CHANGE/);
});

test('Portfolio identity cannot be hot-switched and bot-only persistence receives a strategy snapshot',()=>{
  const definitions=fs.readFileSync(path.join(process.cwd(),'lib/settings/definitions.ts'),'utf8');
  const config=fs.readFileSync(path.join(process.cwd(),'lib/config.ts'),'utf8');
  const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const persistence=fs.readFileSync(path.join(process.cwd(),'lib/trades/persistence.ts'),'utf8');
  assert.doesNotMatch(definitions,/key:'SYMBOL'|key:'DELTA_ENV'/);
  const mapping=config.match(/const mapping:[\s\S]*?=\{([^}]*)\}/)?.[1]||'';
  assert.doesNotMatch(mapping,/SYMBOL|DELTA_ENV/);
  assert.match(worker,/strategyConfig:botStrategyConfigSnapshot\(\)/);
  assert.match(persistence,/source:'bot',[\s\S]*?strategyConfig:trade\.strategyConfig/);
  assert.doesNotMatch(persistence,/source:'exchange_existing',strategyConfig/);
});
