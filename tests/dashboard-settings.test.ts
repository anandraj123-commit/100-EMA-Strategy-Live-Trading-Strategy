import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { calculateCurrentPnL, paginateItems } from '../lib/dashboard';
import { runtimeSettingDefaults, runtimeSettingMetadata, validateRuntimeSettings } from '../lib/settings/definitions';
import { GET as getSettings, PUT as putSettings } from '../app/api/settings/route';

test('runtime settings expose supported defaults without any secret names',()=>{
  const defaults=runtimeSettingDefaults(),keys=Object.keys(defaults),metadata=runtimeSettingMetadata();
  assert.equal(keys.includes('SYMBOL'),false);assert.equal(keys.includes('DELTA_ENV'),false);assert.ok(keys.includes('EMA_LENGTH'));assert.ok(keys.includes('AUTO_TRADE'));
  for(const forbidden of ['DELTA_API_KEY','DELTA_API_SECRET','MONGODB_URI','AUTH_SECRET','PASSWORD','SESSION_SECRET'])assert.equal(keys.includes(forbidden),false);
  assert.equal(metadata.every(item=>item.restartRequired===true),true);
});

test('safe setting validation preserves types and rejects invalid, unknown, and secret values',()=>{
  assert.deepEqual(validateRuntimeSettings({AUTO_TRADE:true,EMA_LENGTH:100,RESOLUTION:'5m'}),{AUTO_TRADE:true,EMA_LENGTH:100,RESOLUTION:'5m'});
  assert.throws(()=>validateRuntimeSettings({AUTO_TRADE:'true'}),/boolean/);
  assert.throws(()=>validateRuntimeSettings({EMA_LENGTH:Number.NaN}),/integer/);
  assert.throws(()=>validateRuntimeSettings({RESOLUTION:'weekly'}),/Unsupported/);
  assert.throws(()=>validateRuntimeSettings({SYMBOL:'XAUTUSD'}),/Unknown or protected/);
  assert.throws(()=>validateRuntimeSettings({UNKNOWN_SETTING:1}),/Unknown or protected/);
  assert.throws(()=>validateRuntimeSettings({DELTA_API_SECRET:'secret'}),/Unknown or protected/);
});

test('settings read and write require authentication before database access',async()=>{
  assert.equal((await getSettings(new NextRequest('http://localhost/api/settings'))).status,401);
  assert.equal((await putSettings(new NextRequest('http://localhost/api/settings',{method:'PUT',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({values:{AUTO_TRADE:true}})}))).status,401);
});

test('current P/L covers long profit/loss, short profit/loss, zero, percentage and no position',()=>{
  assert.deepEqual(calculateCurrentPnL({positionSize:2,entryPrice:100,currentPrice:110,contractValue:0.5}),{value:10,percentage:10});
  assert.deepEqual(calculateCurrentPnL({positionSize:2,entryPrice:100,currentPrice:90,contractValue:0.5}),{value:-10,percentage:-10});
  assert.deepEqual(calculateCurrentPnL({positionSize:-2,entryPrice:100,currentPrice:90,contractValue:0.5}),{value:10,percentage:10});
  assert.deepEqual(calculateCurrentPnL({positionSize:-2,entryPrice:100,currentPrice:110,contractValue:0.5}),{value:-10,percentage:-10});
  assert.deepEqual(calculateCurrentPnL({positionSize:2,entryPrice:100,currentPrice:100,contractValue:0.5}),{value:0,percentage:0});
  assert.deepEqual(calculateCurrentPnL({positionSize:0,entryPrice:100,currentPrice:110,contractValue:0.5}),{value:null,percentage:null});
});

test('bounded pagination returns page metadata and clamps navigation',()=>{
  const first=paginateItems([1,2,3,4,5],1,2),second=paginateItems([1,2,3,4,5],2,2),last=paginateItems([1,2,3,4,5],99,2);
  assert.deepEqual(first.items,[1,2]);assert.deepEqual(second.items,[3,4]);assert.deepEqual(last.items,[5]);
  assert.deepEqual(second.pagination,{page:2,limit:2,total:5,totalPages:3,hasNext:true,hasPrevious:true});
});

test('dashboard renders required tabs, read-only settings default, and mapped sections',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'components/TradingDashboard.tsx'),'utf8');
  for(const tab of ['Environment Variables','Profit','History','Decision Log','Trade / Synchronisation Events','Pending Setup','Active Trade','Strategy / Guardrails','Latest Decision'])assert.match(source,new RegExp(tab.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(source,/useState\(false\).*settingsEditing|settingsEditing.*useState\(false\)/s);
  assert.match(source,/activeTab==='Profit'/);assert.match(source,/activeTab==='History'/);assert.match(source,/activeTab==='Active Trade'/);
});
