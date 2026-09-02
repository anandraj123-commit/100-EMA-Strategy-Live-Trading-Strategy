import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyRuntimeConfigOverrides,config,validateRiskBase } from '../lib/config';
import { runtimeSettingDefaults,runtimeSettingMetadata,validateRuntimeSettings } from '../lib/settings/definitions';
import { sanitizeRuntimeSettingOverrides } from '../lib/settings/repository';
import { finalPreOrderSafetyCheck,type FinalPreOrderDependencies } from '../lib/runtime/final-preorder';

const pending={direction:'long' as const,trigger:100,sl:90,candleTime:1_000,configRevision:'rev'};
const input={identity:{portfolioId:'p1',environment:'demo' as const,symbol:'BTCUSD',productId:27},setup:pending,config:{revision:'rev',autoTrade:true,entryValidCandles:2,resolutionSec:60,riskPct:1,rr:8,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:100,gstPct:18},product:{id:27,contractValue:1,tickSize:0.01,takerRate:0.0005}};
const dependencies=(available:number):FinalPreOrderDependencies=>({robotRunning:()=>true,refreshConfig:async()=>input.config,currentPending:()=>pending,latestCompletedCandleTime:()=>1_059,leaseOwned:async()=>true,leaseLost:()=>false,portfolioEntryAllowed:async()=>true,portfolio:async()=>({id:'p1',environment:'demo',symbol:'BTCUSD',productId:27}),position:async()=>({size:0}),availableMargin:async()=>available});

test('canonical environment RISK_BASE available is accepted',()=>assert.equal(validateRiskBase('available'),'available'));
test('environment RISK_BASE equity is rejected',()=>assert.throws(()=>validateRiskBase('equity'),/must be available/));
test('runtime settings accept only available and reject equity',()=>{assert.deepEqual(validateRuntimeSettings({RISK_BASE:'available'}),{RISK_BASE:'available'});assert.throws(()=>validateRuntimeSettings({RISK_BASE:'equity'}),/available/);});
test('runtime metadata and defaults expose only the canonical risk base',()=>{assert.equal(runtimeSettingDefaults().RISK_BASE,'available');const risk=runtimeSettingMetadata().find(item=>item.key==='RISK_BASE');assert.equal(risk?.defaultValue,'available');});
test('legacy stored equity is discarded so canonical available fallback applies',()=>assert.deepEqual(sanitizeRuntimeSettingOverrides({RISK_BASE:'equity',RR:5}),{RR:5}));
test('valid stored available survives runtime sanitization',()=>assert.deepEqual(sanitizeRuntimeSettingOverrides({RISK_BASE:'available',RR:5}),{RISK_BASE:'available',RR:5}));
test('direct runtime override cannot install unsupported equity',()=>{const before=config.riskBase;assert.throws(()=>applyRuntimeConfigOverrides({RISK_BASE:'equity'}),/must be available/);assert.equal(config.riskBase,before);});
test('risk amount uses available margin and has no wallet-equity input',async()=>{const result=await finalPreOrderSafetyCheck(input,dependencies(2_000));assert.equal(result.ok,true);if(result.ok)assert.equal(result.riskAmount,20);});
test('fresh entry-time available margin replaces an earlier setup-time balance',async()=>{const setupAvailable=2_000;void setupAvailable;const result=await finalPreOrderSafetyCheck(input,dependencies(1_500));assert.equal(result.ok,true);if(result.ok)assert.deepEqual([result.available,result.riskAmount],[1_500,15]);});
test('live sizing paths never select wallet equity as the risk base',()=>{const worker=fs.readFileSync(path.join(process.cwd(),'worker.ts'),'utf8'),finalBarrier=fs.readFileSync(path.join(process.cwd(),'lib/runtime/final-preorder.ts'),'utf8');assert.match(worker,/const freshRiskBase = freshAvailable/);assert.doesNotMatch(worker,/freshRiskBase\s*=\s*freshEquity/);assert.match(finalBarrier,/riskAmount=available\*currentConfig\.riskPct\/100/);assert.doesNotMatch(finalBarrier,/equity|walletEquity/);});
test('existing OPEN trade restoration remains isolated from current RISK_BASE',()=>{const restoration=fs.readFileSync(path.join(process.cwd(),'lib/trades/open-bot-restoration.ts'),'utf8');assert.doesNotMatch(restoration,/config|RISK_BASE|riskBase/);});
