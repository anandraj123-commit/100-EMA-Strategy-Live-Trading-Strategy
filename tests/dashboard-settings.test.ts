import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { autoTradeStatus, calculateCurrentPnL, effectiveAutoTrade, paginateItems } from '../lib/dashboard';
import { runtimeSettingDefaults, runtimeSettingMetadata, validateRuntimeSettings } from '../lib/settings/definitions';
import { GET as getSettings, PUT as putSettings } from '../app/api/settings/route';
import { liveAutoTradeValue } from '../lib/settings/live';

test('runtime settings expose supported defaults without any secret names',()=>{
  const defaults=runtimeSettingDefaults(),keys=Object.keys(defaults),metadata=runtimeSettingMetadata();
  assert.equal(keys.includes('SYMBOL'),false);assert.equal(keys.includes('DELTA_ENV'),false);assert.ok(keys.includes('EMA_LENGTH'));assert.ok(keys.includes('AUTO_TRADE'));
  for(const forbidden of ['DELTA_API_KEY','DELTA_API_SECRET','MONGODB_URI','AUTH_SECRET','PASSWORD','SESSION_SECRET'])assert.equal(keys.includes(forbidden),false);
  assert.equal(metadata.every(item=>item.restartRequired===false),true);
  assert.equal(keys.includes('ENTRY_VALID_CANDLES'),true);
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

test('dashboard auto-trade status has explicit labels and color tones',()=>{
  assert.deepEqual(autoTradeStatus(false),{label:'AUTO TRADE OFF',tone:'off'});
  assert.deepEqual(autoTradeStatus(true),{label:'AUTO TRADE ON',tone:'on'});
  const css=fs.readFileSync(path.join(process.cwd(),'app/style.css'),'utf8');
  assert.match(css,/\.autoTradeBadge\.off\{[^}]*background:\s*#[a-f\d]+/i);
  assert.match(css,/\.autoTradeBadge\.on\{[^}]*background:\s*#[a-f\d]+/i);
});

test('effective AUTO_TRADE requires both Robot Running and the configured preference',()=>{
  assert.equal(effectiveAutoTrade(false,true),false);
  assert.equal(effectiveAutoTrade(false,false),false);
  assert.equal(effectiveAutoTrade(true,false),false);
  assert.equal(effectiveAutoTrade(true,true),true);
});

test('auto-trade badge immediately follows Delta connectivity in the shared portfolio dashboard',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'components/TradingDashboard.tsx'),'utf8');
  assert.match(source,/DELTA OFFLINE · RECONNECTING'[\s\S]*?<\/div>\s*<div className={`autoTradeBadge/);
  assert.equal((source.match(/className={`autoTradeBadge/g)||[]).length,1);
  assert.match(source,/fetch\(`\/api\/status\?\$\{portfolioQuery\}`/);
});

test('portfolio snapshots independently drive demo and real auto-trade badges',()=>{
  const btcDemo={portfolioId:'btc-demo',environment:'demo',running:true,configuredAutoTrade:true};
  const xautDemo={portfolioId:'xaut-demo',environment:'demo',running:false,configuredAutoTrade:true};
  const btcReal={portfolioId:'btc-real',environment:'real',running:true,configuredAutoTrade:false};
  assert.equal(autoTradeStatus(effectiveAutoTrade(btcDemo.running,btcDemo.configuredAutoTrade)).label,'AUTO TRADE ON');
  assert.equal(autoTradeStatus(effectiveAutoTrade(xautDemo.running,xautDemo.configuredAutoTrade)).label,'AUTO TRADE OFF');
  assert.equal(autoTradeStatus(effectiveAutoTrade(btcReal.running,btcReal.configuredAutoTrade)).label,'AUTO TRADE OFF');
});

test('worker publishes effective AUTO_TRADE after MongoDB overrides without exposing secrets',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const applyIndex=source.indexOf('applyRuntimeConfigOverrides(effectiveRuntimeSettings)');
  const effectiveStatusIndex=source.indexOf('autoTrade:config.autoTrade',applyIndex);
  assert.ok(applyIndex>=0&&effectiveStatusIndex>applyIndex);
  const statusFields=source.slice(effectiveStatusIndex,effectiveStatusIndex+500);
  for(const secret of ['apiKey','apiSecret','DELTA_API_KEY','DELTA_API_SECRET','MONGODB_URI','AUTH_SECRET'])assert.equal(statusFields.includes(secret),false);
});

test('worker and dashboard expose configured and effective AUTO_TRADE separately',()=>{
  const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  const dashboard=fs.readFileSync(path.join(process.cwd(),'components/TradingDashboard.tsx'),'utf8');
  const control=fs.readFileSync(path.join(process.cwd(),'app/api/control/route.ts'),'utf8');
  assert.match(worker,/configuredAutoTrade:config\.autoTrade/);
  assert.match(worker,/effectiveAutoTrade:robotRunningNow&&config\.autoTrade/);
  assert.match(dashboard,/autoTradeStatus\(s\.effectiveAutoTrade\)/);
  assert.match(dashboard,/effectiveAutoTrade:effectiveAutoTrade\(running,prev\.configuredAutoTrade\)/);
  assert.doesNotMatch(control,/saveRuntimeSettingOverrides|runtime_settings|AUTO_TRADE/);
});

test('AUTO_TRADE hot reload accepts persisted boolean transitions and retains the effective fallback when absent',()=>{
  assert.equal(liveAutoTradeValue({AUTO_TRADE:false},true),false);
  assert.equal(liveAutoTradeValue({AUTO_TRADE:true},false),true);
  assert.equal(liveAutoTradeValue({},true),true);
  assert.throws(()=>liveAutoTradeValue({AUTO_TRADE:'true'},false),/boolean/);
});

test('worker refreshes portfolio runtime settings before each cycle without restarting or changing open-trade state',()=>{
  const source=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8');
  assert.match(source,/async function refreshRuntimeSettings\(\)[\s\S]*?getRuntimeSettingOverrides\(portfolioId\)[\s\S]*?changedRuntimeSettings/);
  assert.match(source,/while \(!shuttingDown\) \{\s*try \{\s*await refreshRuntimeSettings\(\)/);
  const refreshBody=source.match(/async function refreshRuntimeSettings\(\)\{([\s\S]*?)\n\}/)?.[1]||'';
  assert.equal(refreshBody.includes('activeTrade='),false);
  for(const protectedAction of ['placeMarketOrder','placeBracket','writeControl'])assert.equal(refreshBody.includes(protectedAction),false);
});
