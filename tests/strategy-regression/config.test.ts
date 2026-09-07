import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('configuration defaults to 5m and applies EMA75/EMA100 runtime overrides',()=>{
  const configUrl=new URL('../../lib/config.ts',import.meta.url).href;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import configModule from ${JSON.stringify(configUrl)};
    const {config,applyRuntimeConfigOverrides}=configModule;
    assert.equal(config.resolution,'5m');
    assert.equal(config.resolutionSec,300);
    applyRuntimeConfigOverrides({EMA_LENGTH:75,SLOPE_LOOKBACK:3});
    assert.equal(config.emaLen,75);
    assert.equal(config.candleHistoryBars,763);
    applyRuntimeConfigOverrides({EMA_LENGTH:100});
    assert.equal(config.emaLen,100);
    assert.equal(config.candleHistoryBars,1013);
    applyRuntimeConfigOverrides({RESOLUTION:'15m'});
    assert.equal(config.resolutionSec,900);
  `],{encoding:'utf8',env:{...process.env,RESOLUTION:''}});
  assert.equal(result.status,0,result.stderr);
});
