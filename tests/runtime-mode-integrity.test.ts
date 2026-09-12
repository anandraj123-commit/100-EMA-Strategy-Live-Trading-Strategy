import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { validateStatusMode } from '../lib/runtime/status-mode';
import { config as defaults } from '../lib/config';
import { deltaErrorDetails, DeltaRequestError } from '../lib/delta';
import * as liveSettings from '../lib/settings/live';
import * as dashboard from '../lib/dashboard';
import AppModeBadge from '../components/AppModeBadge';
import type { AppMode } from '../lib/app-mode';
import { workerHarness } from './strategy-regression/worker-harness';

const {renderToStaticMarkup}=require('react-dom/server') as {renderToStaticMarkup(node:React.ReactNode):string};
const compile=(source:string)=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
function execute(source:string,modules:Record<string,unknown>,globals:Record<string,unknown>={}){
  const module={exports:{} as any};
  vm.runInNewContext(compile(source),{module,exports:module.exports,console,...globals,require:(name:string)=>{assert.ok(name in modules,`Unexpected import ${name}`);return modules[name];}});
  return module.exports;
}
const foreign={appMode:'production',env:'live',running:true,price:98765432,markPrice:98765432,lastTradedPrice:98765432,spotPrice:98765432,equity:98765432,available:98765432,position:{size:10,entryPrice:98765432},pending:{trigger:98765432},activeTrade:{sl:98765432,tp:98765432},connection:{state:'online'},strategy:{resolution:'5m'},currentStatus:{action:'ENTRY'},logs:[{secret:'old-log'}],tradeEvents:[{secret:'old-event'}]};

async function readThroughApi(snapshot:unknown){
  let reads=0;
  const route=execute(fs.readFileSync('app/api/status/route.ts','utf8'),{
    '../../../lib/app-mode':{getAppMode:()=> 'testing'},
    '../../../lib/runtime/status-mode':{validateStatusMode},
    'next/server':{NextResponse:{json:(body:unknown)=>body}},
    '../../../lib/state':{readStatus:()=>{reads++;return snapshot;}},
    '../../../lib/auth/api':{requireApiSession:async()=>({ok:true})},
    '../../../lib/portfolio/access':{resolvePortfolioId:async()=>({_id:{toHexString:()=> 'portfolio-id'}})}
  });
  const response=await route.GET({nextUrl:{searchParams:{get:()=> 'portfolio-id'}}});
  assert.equal(reads,1);
  return response;
}

test('status API rejects Production snapshot under Testing without relabelling or retaining runtime values',async()=>{
  const original=structuredClone(foreign),response=await readThroughApi(foreign);
  assert.equal(response.appMode,'testing');assert.equal(response.running,false);assert.equal(response.statusAvailable,false);
  assert.equal(response.currentStatus.reason,'STATUS_MODE_MISMATCH');
  assert.match(response.error,/PRODUCTION.*TESTING/);assert.match(response.error,/Start the worker/);
  for(const field of ['env','price','markPrice','lastTradedPrice','spotPrice','equity','available','position','pending','activeTrade','strategy','logs','tradeEvents'])assert.equal(field in response,false,field);
  assert.equal(response.connection.state,'unavailable');assert.notEqual(response.currentStatus.action,'ENTRY');
  assert.deepEqual(foreign,original);
});

test('matching status is returned intact without overwriting worker metadata',async()=>{
  const snapshot={...foreign,appMode:'testing',env:'demo'},original=structuredClone(snapshot);
  const response=await readThroughApi(snapshot);
  assert.equal(response,snapshot);assert.deepEqual(response,original);assert.equal(response.running,true);
});

test('legacy, absent, malformed or invalid-mode status is untrusted and never modified',async()=>{
  const {appMode:_,...legacy}=foreign;
  for(const snapshot of [legacy,{},null,[],{...foreign,appMode:null},{...foreign,appMode:'untrusted-value'}]){
    const original=structuredClone(snapshot),response=await readThroughApi(snapshot);
    assert.equal(response.appMode,'testing');assert.equal(response.currentStatus.reason,'STATUS_MODE_UNKNOWN');
    assert.equal(response.running,false);assert.equal(response.position,undefined);assert.equal(response.price,undefined);
    assert.match(response.error,/Fresh worker status required/);assert.doesNotMatch(response.error,/untrusted-value/);
    assert.deepEqual(snapshot,original);
  }
});

test('snapshot validation covers each ordered pair of application modes',()=>{
  for(const current of ['development','testing','production'] as const)for(const recorded of ['development','testing','production'] as const){
    const snapshot={...foreign,appMode:recorded},result=validateStatusMode(snapshot,current);
    assert.equal(result.appMode,current);
    assert.equal(result.running,current===recorded);
    assert.equal(result.price,current===recorded?foreign.price:undefined);
  }
});

function renderDashboard(snapshot:unknown,appMode:AppMode='testing'){
  let state=0;
  const component=execute(fs.readFileSync('components/TradingDashboard.tsx','utf8'),{
    'react/jsx-runtime':require('react/jsx-runtime'),
    react:{...React,useState:(value:unknown)=>[++state===1?snapshot:value,()=>{}],useEffect:()=>{}},
    './AppModeBadge':{default:AppModeBadge,__esModule:true},
    '../lib/dashboard':dashboard,
    './DecisionLogRow':{default:()=>null,__esModule:true}
  });
  return renderToStaticMarkup(component.default({portfolioId:'portfolio-id',appMode}));
}

test('dashboard shows unavailable mismatch/unknown status with the current badge and no stale values',()=>{
  for(const snapshot of [foreign,{...foreign,appMode:undefined}]){
    const html=renderDashboard(validateStatusMode(snapshot,'testing'));
    assert.match(html,/WORKER STATUS UNAVAILABLE/);assert.match(html,/TESTING/);
    assert.match(html,/role="alert"/);assert.doesNotMatch(html,/98765432/);
    assert.match(html,/STATUS MODE MISMATCH|STATUS MODE UNKNOWN/);
  }
});

test('workspace list also rejects stale running and position state',async()=>{
  const component=execute(fs.readFileSync('components/TradeWorkspaceList.tsx','utf8'),{
    'react/jsx-runtime':require('react/jsx-runtime'),
    'next/link':{default:({children,...props}:any)=>React.createElement('a',props,children),__esModule:true},
    '../lib/portfolio/repository':{listPortfolio:async()=>[{id:'portfolio-id',symbol:'BTCUSD',currentPrice:123}]},
    '../lib/portfolio/service':{portfolioWithPrices:async(rows:unknown)=>rows},
    '../lib/state':{readStatus:()=>foreign},
    '../lib/app-mode':{getAppMode:()=> 'testing'},
    '../lib/runtime/status-mode':{validateStatusMode}
  });
  const html=renderToStaticMarkup(await component.default());
  assert.equal((html.match(/UNAVAILABLE/g)||[]).length,2);assert.doesNotMatch(html,/RUNNING|>OPEN</);
  assert.match(html,/\/futures\/dashboard\/portfolio-id/);
});

const workerFile=ts.createSourceFile('worker.ts',fs.readFileSync('worker.ts','utf8'),ts.ScriptTarget.ES2022,true);
const launcher=workerFile.statements.at(-1)!;
assert.ok(ts.isExpressionStatement(launcher)&&ts.isVoidExpression(launcher.expression));
const workerSource=ts.createPrinter().printFile(ts.factory.updateSourceFile(workerFile,workerFile.statements.slice(0,-1)));

function startup(mode:AppMode,storedId:number,resolvedId:number,options:{credentials?:boolean;error?:Error}={}){
  const events:string[]=[],snapshots:any[]=[],portfolio=Object.freeze({_id:'portfolio-id',symbol:'BTCUSD',productId:storedId,environment:mode==='production'?'demo':'real'});
  const config={...defaults,appMode:mode,env:mode==='production'?'live':'demo',symbol:'BTCUSD'};
  let stop=()=>{};
  const forbidden=(name:string)=>(..._args:any[])=>{events.push(name);throw new Error(`Forbidden I/O: ${name}`);};
  const modules:Record<string,any>={};
  // Explicitly deny all imported I/O unless a stub is supplied below.
  for(const declaration of workerFile.statements){if(ts.isImportDeclaration(declaration)&&ts.isStringLiteral(declaration.moduleSpecifier))modules[declaration.moduleSpecifier.text]=new Proxy({},{get:(_target,name)=>forbidden(String(name))});}
  modules['./lib/config']={config,configurePortfolioRuntime:()=>({environment:mode==='production'?'real':'demo',credentialsConfigured:options.credentials!==false}),applyRuntimeConfigOverrides:()=>{}};
  modules['./lib/portfolio/deletion-state']={portfolioEntryAllowed:async()=>true};
  modules['./lib/portfolio/repository']={findPortfolioById:async()=>portfolio};
  modules['./lib/runtime/leases']={portfolioLeaseKey:()=> 'lease',renewLease:async()=>true};
  modules['./lib/settings/repository']={getRuntimeSettingOverrides:async()=>({})};
  modules['./lib/settings/definitions']={validateRuntimeSettings:(values:any)=>values};
  modules['./lib/settings/live']=liveSettings;
  modules['./lib/db/mongodb']={closeMongoConnection:async()=>{events.push('close');}};
  modules['./lib/delta']={deltaErrorDetails,getProduct:async()=>{events.push('product');if(options.error)throw options.error;return{id:resolvedId,state:'live',trading_status:'operational'};},getTicker:async()=>{events.push('ticker');throw new DeltaRequestError('DELTA_AUTH_ERROR');},placeMarketOrder:forbidden('order'),placeBracket:forbidden('bracket')};
  modules['./lib/risk/daily-loss-streak']={tradingDayKey:()=> 'test-day',restoreDailyLossStreak:async()=>{events.push('restore');return{consecutiveLosses:0,tradingDay:'test-day'};}};
  modules['./lib/entry-intents/service']={reconcilePortfolioEntryIntents:async()=>{events.push('reconcile');return{confirmed:[]};}};
  modules['./lib/entry-intents/repository']={findRecoverableConfirmedEntryIntents:async()=>[],findBlockingEntryIntent:async()=>null};
  modules['./lib/state']={readControl:()=>({running:true}),writeStatus:(snapshot:any)=>{snapshots.push(snapshot);if(!('credentialsConfigured' in snapshot)||snapshot.connection)stop();}};
  const worker=execute(workerSource+'\nmodule.exports={main,cycle,stop:()=>{shuttingDown=true;},inspect:()=>({runtimeProductId,product})};',modules,{
    process:{env:{PORTFOLIO_RUNTIME_ID:'portfolio-id',PORTFOLIO_RUNTIME_LEASE_OWNER:'owner'},once:()=>{}},
    setInterval:()=>0,clearInterval:()=>{},setTimeout:(callback:()=>void)=>{callback();return 0;}
  });
  stop=worker.stop;
  return{worker,events,snapshots,portfolio};
}

for(const mode of ['testing','production','development'] as const)test(`${mode}: mismatched product fails explicitly before restoration or orders without mutation`,async()=>{
  const h=startup(mode,27,84);
  await h.worker.main();
  const snapshot=h.snapshots.at(-1);
  assert.equal(snapshot.appMode,mode);assert.equal(snapshot.currentStatus.reason,'PORTFOLIO_PRODUCT_MODE_MISMATCH');
  assert.equal(snapshot.connection.code,'PORTFOLIO_PRODUCT_MODE_MISMATCH');
  assert.match(snapshot.error,new RegExp(mode.toUpperCase()));assert.match(snapshot.error,/27.*84/);
  assert.equal(snapshot.productCompatibility.storedProductId,27);assert.equal(snapshot.productCompatibility.resolvedProductId,84);
  assert.equal(snapshot.productCompatibility.portfolioId,'portfolio-id');assert.equal(snapshot.productCompatibility.symbol,'BTCUSD');
  assert.equal(h.portfolio.productId,27);assert.equal(h.worker.inspect().runtimeProductId,27);
  assert.deepEqual(h.events,['product','close']);
  // The existing per-cycle barrier still independently rejects mismatched identity.
  await assert.rejects(h.worker.cycle(),(error:any)=>error.code==='PORTFOLIO_PRODUCT_MODE_MISMATCH');
  assert.deepEqual(h.events,['product','close']);
});

test('matching Demo product permits normal restoration in order, retains identity, and stamps later error status',async()=>{
  const h=startup('testing',84,84);
  await h.worker.main();
  assert.deepEqual(h.events,['product','restore','reconcile','ticker','close']);
  assert.equal(h.portfolio.productId,84);assert.equal(h.worker.inspect().runtimeProductId,84);
  assert.equal(h.snapshots.at(-1).appMode,'testing');assert.equal(h.snapshots.at(-1).connection.code,'DELTA_AUTH_ERROR');
  assert.equal(h.snapshots.at(-1).productCompatibility,undefined);
});

test('initial public network errors and credentials status retain current appMode',async()=>{
  for(const options of [{error:new DeltaRequestError('DELTA_NETWORK_OFFLINE')},{credentials:false}]){
    const h=startup('testing',84,84,options);await h.worker.main();
    assert.ok(h.snapshots.length>0);for(const snapshot of h.snapshots)assert.equal(snapshot.appMode,'testing');
    if(options.error)assert.equal(h.events.includes('restore'),false);
  }
});

test('product mismatch renders an actionable dashboard error without replacing the mode badge',async()=>{
  const h=startup('production',27,84);await h.worker.main();
  const html=renderDashboard(h.snapshots.at(-1),'production');
  assert.match(html,/Portfolio metadata incompatible with PRODUCTION mode/);
  assert.match(html,/PORTFOLIO PRODUCT MODE MISMATCH/);assert.match(html,/role="alert"/);
});

test('every worker snapshot-writing branch explicitly records appMode',()=>{
  let writes=0;
  function visit(node:ts.Node){
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='writeStatus'){
      writes++;const object=node.arguments[0];assert.ok(ts.isObjectLiteralExpression(object));
      assert.ok(object.properties.some(property=>ts.isPropertyAssignment(property)&&property.name.getText(workerFile)==='appMode'));
    }
    ts.forEachChild(node,visit);
  }
  visit(workerFile);assert.equal(writes,3);
});

for(const running of [true,false])test(`normal monitoring snapshot records appMode while robot running=${running}`,async()=>{
  const h=workerHarness();
  Object.assign(h.config,{appMode:'testing'});
  if(!running)h.stop();
  await h.cycle(1_800_000,[],100);
  assert.equal(h.status().appMode,'testing');
  assert.equal(h.status().running,running);
  assert.equal(h.status().connection.state,'online');
  assert.equal(h.orders.length,0);
});
