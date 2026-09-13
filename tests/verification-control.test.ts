import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
import { NextRequest,NextResponse } from 'next/server';
import * as definitions from '../lib/settings/definitions';
import { resolveModeConfig } from '../lib/app-mode';
import { finalPreOrderDispatchStateCheck,finalPreOrderSafetyCheck,type FinalPreOrderInput,type FinalPreOrderDependencies } from '../lib/runtime/final-preorder';
import { verificationWorker } from './support/verification-worker';
import { calculateCurrentPnL } from '../lib/dashboard';

function execute(file:string,modules:Record<string,any>,globals:Record<string,any>={}){
 const module={exports:{} as any};const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,console,...globals,require:(name:string)=>{assert.ok(name in modules,name);return modules[name];}});return module.exports;
}
function fixture(){
 let mode='testing';const databases=new Map<string,Map<string,Map<string,any>>>(),controls=new Map<string,boolean>(),writes:any[]=[];
 const table=(name:string)=>{if(!databases.has(mode))databases.set(mode,new Map());const db=databases.get(mode)!;if(!db.has(name))db.set(name,new Map());return db.get(name)!;};
 const matches=(row:any,q:any):boolean=>!!row&&Object.entries(q).every(([key,value]:any)=>key==='$or'?value.some((item:any)=>matches(row,item)):value&&typeof value==='object'&&!(value instanceof Date)?Object.entries(value).every(([op,limit]:any)=>op==='$gt'?row[key]>limit:op==='$lte'?row[key]<=limit:false):row[key]===value);
 const getDb=async()=>({collection:(name:string)=>{
  const rows=table(name);return {createIndex:async()=>'',findOne:async(q:any)=>[...rows.values()].find(row=>matches(row,q))??null,
   findOneAndUpdate:async(q:any,u:any)=>{const previous=rows.get(q._id);if(previous&&!matches(previous,q))throw Object.assign(new Error('locked'),{code:11000});const row={_id:q._id,...u.$set};rows.set(q._id,row);return row;},
   updateOne:async(q:any,u:any)=>{const previous=rows.get(q._id),row={_id:q._id,...previous,...(!previous?u.$setOnInsert:{}),...u.$set};rows.set(q._id,row);if(name==='runtime_settings')writes.push(structuredClone(row));return{modifiedCount:1};},
   deleteOne:async(q:any)=>({deletedCount:matches(rows.get(q._id),q)&&rows.delete(q._id)?1:0})};
 }});
 const locks=execute('lib/runtime/leases.ts',{'node:crypto':crypto,'../db/mongodb':{getDb}});
 const state={writeControl:(value:any,id:string)=>controls.set(id,value.running)};
 const repository=execute('lib/settings/repository.ts',{'node:crypto':crypto,'../db/mongodb':{getDb},'./definitions':definitions,'../state':state,'../runtime/leases':locks});
 const auth={requireApiSession:async()=>({ok:true,session:{user:{email:'admin'}}})},access={resolvePortfolioId:async(id:string)=>id==='forbidden'?null:{_id:{toHexString:()=>id}}};
 const api=execute('app/api/control/route.ts',{'next/server':{NextResponse},'../../../lib/state':state,'../../../lib/settings/repository':repository,'../../../lib/settings/definitions':definitions,'../../../lib/auth/api':auth,'../../../lib/portfolio/access':access});
 const settingsApi=execute('app/api/settings/route.ts',{'next/server':{NextResponse},'../../../lib/settings/repository':repository,'../../../lib/settings/definitions':definitions,'../../../lib/auth/api':auth,'../../../lib/portfolio/access':access,'../../../lib/portfolio/deletion-state':{portfolioEntryAllowed:async()=>true}});
 const start=(id:string,running=true)=>api.POST(new NextRequest('http://localhost/api/control',{method:'POST',body:JSON.stringify({portfolioId:id,running})}));
 const save=(id:string,values:any)=>settingsApi.PUT(new NextRequest('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({portfolioId:id,values})}));
 return{repository,locks,table,controls,writes,start,save,mode:(value:string)=>{mode=value;}};
}

test('new settings persist verified=false; legacy or malformed approval is false; booleans are strict',async()=>{
 const f=fixture();await f.repository.createRuntimeSettingsIfMissing('a');const row=f.table('runtime_settings').get('portfolio:a');
 assert.equal(row.verified,false);assert.equal(row.portfolioId,'a');assert.equal(row.values.VERIFIED,undefined);
 for(const value of ['true',1,'yes',null,undefined])assert.throws(()=>definitions.validateRuntimeSettings({VERIFIED:value}),/boolean/);
 for(const verified of [undefined,false,'true',1]){f.table('runtime_settings').set('portfolio:legacy',{_id:'portfolio:legacy',verified,values:{AUTO_TRADE:true,VERIFIED:true}});assert.equal((await f.repository.getRuntimeSettingOverrides('legacy')).VERIFIED,false);assert.equal((await f.start('legacy')).status,409);}
 assert.equal(f.controls.get('legacy'),undefined);
});
for(const verified of [false,true])for(const autoTrade of [false,true])test(`START requires both flags: verified=${verified}, autoTrade=${autoTrade}`,async()=>{
 const f=fixture();await f.save('a',{AUTO_TRADE:autoTrade});await f.save('a',{VERIFIED:verified});
 assert.notEqual(f.controls.get('a'),true);const response=await f.start('a'),body=await response.json();assert.equal(response.status,verified&&autoTrade?200:409);
 if(!autoTrade)assert.equal(body.code,'AUTO_TRADE_OFF');else if(!verified)assert.equal(body.code,'ENVIRONMENT_NOT_VERIFIED');
 assert.equal(f.controls.get('a'),verified&&autoTrade);
 const before=JSON.stringify(await f.repository.getRuntimeSettingOverrides('a'));await f.start('a',false);assert.equal(f.controls.get('a'),false);assert.equal(JSON.stringify(await f.repository.getRuntimeSettingOverrides('a')),before);
});
const alternatives:Record<string,any>={AUTO_TRADE:false,RESOLUTION:'1m',POLL_MS:2000,EMA_LENGTH:120,SLOPE_LOOKBACK:4,ENTRY_VALID_CANDLES:3,RR:9,RISK_PCT:0.5,MAX_DAILY_CONSECUTIVE_LOSSES:4,MIN_STOP_PCT:0.2,MAX_EFFECTIVE_LEVERAGE:30,MAX_FEE_RISK_PCT:30,GST_PCT:17,ORDER_LEVERAGE:20,PRICE_SOURCE:'mark'};
for(const definition of definitions.runtimeSettingMetadata().filter(d=>d.key!=='VERIFIED'))test(`${definition.key}: a meaningful save atomically overrides submitted approval`,async()=>{
 const f=fixture();await f.save('a',{...definitions.runtimeSettingDefaults(),AUTO_TRADE:true});await f.save('a',{VERIFIED:true});await f.start('a');
 const before=await f.repository.getRuntimeSettingOverrides('a');let value=alternatives[definition.key];
 if(definition.key==='RISK_BASE')value='available';else if(value===before[definition.key])value=definition.type==='number'?Number(value)+1:definition.key==='RESOLUTION'?'15m':definition.key==='PRICE_SOURCE'?'spot':!value;
 const changed=value!==before[definition.key],count=f.writes.length,response=await f.save('a',{[definition.key]:value,VERIFIED:true}),saved=await response.json();
 assert.equal(response.status,200);assert.equal(saved.values[definition.key],value);assert.equal(saved.verified,!changed);assert.equal(saved.values.VERIFIED,!changed);
 assert.equal(f.writes.length,count+1);assert.equal(f.writes.at(-1).verified,!changed);assert.equal(f.controls.get('a'),!changed);
 if(changed){await f.save('a',{VERIFIED:true});assert.equal(f.controls.get('a'),false);}
});
test('unchanged normalized save preserves verification/revision/running and both directions of AUTO_TRADE revoke approval',async()=>{
 const f=fixture();await f.save('a',{AUTO_TRADE:true});await f.save('a',{VERIFIED:true});await f.start('a');const before=await f.repository.getRuntimeSettingsSnapshot('a');
 await f.save('a',before.values);assert.equal((await f.repository.getRuntimeSettingsSnapshot('a')).entryRevision,before.entryRevision);assert.equal(f.controls.get('a'),true);
 for(const AUTO_TRADE of [false,true]){await f.save('a',{AUTO_TRADE,VERIFIED:true});assert.equal((await f.repository.getRuntimeSettingOverrides('a')).VERIFIED,false);assert.equal(f.controls.get('a'),false);}
});
test('rapid revoke/reapprove changes revision and cannot revive control or affect a neighbor',async()=>{
 const f=fixture();for(const id of ['a','b']){await f.save(id,{AUTO_TRADE:true});await f.save(id,{VERIFIED:true});await f.start(id);}
 const beforeA=JSON.stringify(await f.repository.getRuntimeSettingsSnapshot('a')),beforeB=await f.repository.getRuntimeSettingsSnapshot('b');
 await f.save('b',{VERIFIED:false});assert.equal(f.controls.get('b'),false);await f.save('b',{VERIFIED:true});
 assert.notEqual((await f.repository.getRuntimeSettingsSnapshot('b')).entryRevision,beforeB.entryRevision);assert.equal(JSON.stringify(await f.repository.getRuntimeSettingsSnapshot('a')),beforeA);assert.equal(f.controls.get('a'),true);assert.equal(f.controls.get('b'),false);
 f.table('runtime_settings').set('portfolio:legacy',{_id:'portfolio:legacy',values:{AUTO_TRADE:true}});f.controls.set('legacy',true);await f.save('legacy',{VERIFIED:true});assert.equal(f.controls.get('legacy'),false);
});
test('entry lease serializes successful publication; API access checks remain required',async()=>{
 const f=fixture();await f.save('a',{AUTO_TRADE:true});await f.save('a',{VERIFIED:true});const lease=await f.locks.acquireLease(f.locks.portfolioEntryLeaseKey('a'),'entry',90000),before=JSON.stringify(await f.repository.getRuntimeSettingsSnapshot('a'));
 assert.equal((await f.save('a',{VERIFIED:false})).status,409);assert.equal((await f.start('a')).status,409);assert.equal(JSON.stringify(await f.repository.getRuntimeSettingsSnapshot('a')),before);
 await f.locks.releaseLease(lease);await f.save('a',{VERIFIED:false});assert.equal((await f.start('a')).status,409);
 assert.equal((await f.save('forbidden',{VERIFIED:true})).status,404);assert.equal((await f.start('forbidden')).status,404);assert.equal(f.table('runtime_settings').has('portfolio:forbidden'),false);
});
test('verification follows the selected APP_MODE database only',async()=>{
 const f=fixture(),env:Record<string,string>={};for(const mode of ['development','testing','production'])for(const prefix of ['MONGODB_URI','MONGODB_DB','AUTH_SECRET','DELTA_API_KEY','DELTA_API_SECRET'])env[`${prefix}_${mode.toUpperCase()}`]=`${prefix}-${mode}-test-placeholder-at-least-32-characters`;
 for(const appMode of ['development','testing','production']){const config=resolveModeConfig({...env,APP_MODE:appMode});f.mode(config.mongo.database);assert.equal((await f.repository.getRuntimeSettingOverrides('same-id')).VERIFIED,false);await f.save('same-id',{VERIFIED:true});}
});

const input:FinalPreOrderInput={identity:{portfolioId:'a',environment:'demo',symbol:'BTCUSD',productId:27},setup:{direction:'long',trigger:100,sl:90,candleTime:1200,configRevision:'r'},config:{revision:'r',verified:true,autoTrade:true,entryValidCandles:2,resolutionSec:300,riskPct:1,rr:2,minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:100,gstPct:18},product:{id:27,contractValue:0.1,tickSize:0.5,takerRate:0.0005}};
function deps():FinalPreOrderDependencies{return{robotRunning:()=>true,refreshConfig:async()=>input.config,currentPending:()=>input.setup,latestCompletedCandleTime:()=>1500,leaseOwned:async()=>true,leaseLost:()=>false,portfolioEntryAllowed:async()=>true,portfolio:async()=>({id:'a',...input.identity}),position:async()=>({size:0}),availableMargin:async()=>1000};}
for(const verified of [false,undefined])test(`direct final dispatch rejects verified=${verified}`,async()=>{
 const d=deps();d.refreshConfig=async()=>({...input.config,verified:verified as any});assert.equal((await finalPreOrderSafetyCheck(input,d)).ok,false);assert.deepEqual(finalPreOrderDispatchStateCheck(input,d,{...input.config,verified:verified as any}),{ok:false,reason:'ENVIRONMENT_NOT_VERIFIED'});
});
test('revocation during final sizing blocks dispatch without changing risk/SL/TP computations',async()=>{
 const d=deps();const approved=await finalPreOrderSafetyCheck(input,d);assert.ok(approved.ok);assert.equal(approved.riskAmount,10);assert.equal(approved.sl,90);assert.equal(approved.tp,120);assert.equal(approved.contracts,10);
 let verified=true;d.refreshConfig=async()=>({...input.config,verified});d.currentConfig=()=>({...input.config,verified});d.availableMargin=async()=>{verified=false;return 1000;};assert.deepEqual(await finalPreOrderSafetyCheck(input,d),{ok:false,reason:'ENVIRONMENT_NOT_VERIFIED'});
});

const history=[90,92,94,96].map((close,i)=>({time:i*300,open:close,high:close+1,low:close-1,close})).concat([{time:1200,open:97,high:101,low:96,close:100}]);
for(const values of [{VERIFIED:false,AUTO_TRADE:true},{VERIFIED:false,AUTO_TRADE:false},{VERIFIED:false,AUTO_TRADE:true,RR:9},{VERIFIED:false,AUTO_TRADE:true,RESOLUTION:'1m'}])test(`worker invalidates pending and does not replay it: ${JSON.stringify(values)}`,async()=>{
 const h=verificationWorker();await h.cycle(1502,history,102);assert.ok(h.inspect().pending);h.settings(values,'edited');await h.refresh();assert.equal(h.inspect().pending,null);assert.equal(h.orders.length,0);
 h.settings({VERIFIED:true,AUTO_TRADE:true},'reviewed');await h.refresh();await h.cycle(1503,history,102);assert.equal(h.status().running,false);h.start();await h.cycle(1802,[...history,{time:1500,open:100,high:100,low:100,close:100}],102);assert.equal(h.orders.length,0);assert.equal(h.inspect().pending,null);
});
test('rapid edit/reverify between worker polls invalidates only that portfolio',async()=>{
 const a=verificationWorker(),b=verificationWorker();await a.cycle(1502,history,102);await b.cycle(1502,history,102);b.settings({VERIFIED:true},'new-generation');await b.refresh();assert.equal(b.inspect().pending,null);assert.ok(a.inspect().pending);
});
test('missing runtime approval fails closed, including against a true process-local fallback',async()=>{
 const h=verificationWorker();h.settings({},'legacy');await h.refresh();await h.cycle(1502,history,102);assert.equal(h.status().running,false);assert.equal(h.status().verified,false);assert.equal(h.inspect().pending,null);
});
for(const autoTrade of [true,false])test(`unverified open position still loads account data and P/L, AUTO_TRADE=${autoTrade}`,async()=>{
 const h=verificationWorker();h.existingPosition(2);await h.cycle(1502,history,102);h.settings({VERIFIED:false,AUTO_TRADE:autoTrade},'disabled');await h.refresh();await h.cycle(1802,[...history,{time:1500,open:100,high:100,low:100,close:100}],103);
 assert.equal(h.status().running,false);assert.equal(h.status().position.size,2);assert.ok(h.inspect().activeTrade);assert.equal(h.orders.length,0);assert.equal(h.status().equity,99999);assert.equal(h.status().available,1000);
 assert.notEqual(calculateCurrentPnL({positionSize:2,entryPrice:h.status().position.entryPrice,currentPrice:h.status().price,contractValue:h.status().contractValue}).value,null);
});

for(const autoTrade of [false,true])test(`real worker protection adapter repairs SL/TP when unverified, AUTO_TRADE=${autoTrade}`,async()=>{
 const {reconcileProtection}=await import('../lib/trades/protection-reconciliation');const {protectionTriggerMethod,protectionTriggerPrice}=await import('../lib/trades/protection');
 const source=fs.readFileSync('worker.ts','utf8'),file=ts.createSourceFile('worker.ts',source,ts.ScriptTarget.ES2022,true);
 const declarations=file.statements.filter(node=>(ts.isFunctionDeclaration(node)&&['syncExchangeBracket','openTradeProtectionPriceSource'].includes(node.name?.text??''))||(ts.isVariableStatement(node)&&node.getText(file).startsWith('const protectionPriceSources=')));
 const code=ts.transpileModule(declarations.map(n=>n.getText(file)).join('\n')+'\nmodule.exports={syncExchangeBracket,openTradeProtectionPriceSource};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const trade:any={tradeId:'open-trade',source:'bot',attributionStatus:'BOT_CONFIRMED',direction:'long',contracts:2,ownedContracts:2,sl:90,tp:120,mixedPosition:false,strategyConfig:{priceSource:'last'}};
 const order=(leg:string)=>({id:leg,product_id:27,side:'sell',size:2,unfilled_size:2,reduce_only:true,order_type:'market_order',stop_order_type:leg==='sl'?'stop_loss_order':'take_profit_order',stop_price:String(leg==='sl'?90:120),stop_trigger_method:'last_traded_price',state:'pending'});
 let rows:any[]=[],brackets=0,positionReads=0;const module={exports:null as any};
 vm.runInNewContext(code,{module,Date,product:{id:27},activeTrade:trade,cachedPositionSize:2,lastBracketSyncAt:0,BRACKET_SYNC_MS:5000,config:{verified:false,autoTrade,priceSource:'mark'},protectionRepairAttempts:new Set(),protectionTriggerMethod,protectionTriggerPrice,reconcileProtection,
 getPosition:async()=>{positionReads++;return {product_id:27,size:2};},getOpenOrders:async()=>rows,getTicker:async()=>({close:100}),synchronizeTradeProtection:async()=>{},addTradeEvent:()=>{},placeBracket:async(_id:number,sl:number,tp:number,method:string)=>{assert.equal(method,'last_traded_price');assert.equal(sl,90);assert.equal(tp,120);brackets++;rows=[order('sl'),order('tp')];},placeProtectiveStopOrder:async()=>{throw new Error('Unexpected single-leg repair');}});
 assert.equal(module.exports.openTradeProtectionPriceSource(),'last');await module.exports.syncExchangeBracket(true);assert.equal(brackets,1);assert.ok(positionReads>=2);assert.equal(trade.protectionState,'ACTIVE');assert.equal(trade.sl,90);assert.equal(trade.tp,120);
});
test('an open trade without historical settings pins its existing trigger source before applying edits',async()=>{
 const h=verificationWorker();h.existingPosition(2);await h.cycle(1502,history,102);
 h.settings({VERIFIED:false,PRICE_SOURCE:'mark'},'edited');await h.refresh();assert.equal(h.config.priceSource,'mark');
 // The production adapter is the sole consumer of this pinned source.
 assert.equal(h.protectionSource(),'last');assert.equal(h.inspect().activeTrade.sl,90);assert.equal(h.inspect().activeTrade.tp,110);
});
test('stopped worker continues reconciliation and finalizes a closed existing position without new entries',async()=>{
 const h=verificationWorker();h.existingPosition(2);await h.cycle(1502,history,102);h.settings({VERIFIED:false,AUTO_TRADE:false},'off');await h.refresh();h.setPosition(0);await h.cycle(1802,[...history,{time:1500,open:100,high:100,low:100,close:100}],103);
 assert.equal(h.status().position.size,0);assert.equal(h.inspect().activeTrade,null);assert.ok(h.reconciliations()>0);assert.equal(h.closed.length,1);assert.equal(h.orders.length,0);
});
test('already-submitted confirmed intent is persisted while unverified without duplicating its order',async()=>{
 const h=verificationWorker();h.settings({VERIFIED:false,AUTO_TRADE:false},'off');await h.refresh();
 h.confirmed([{intentId:'submitted',direction:'long',trigger:101,sl:96,tp:111,contracts:2,contractValue:.1,deltaOrderId:'accepted-order',clientOrderId:'existing-client',createdAt:new Date(),productId:27,symbol:'XAUTUSD'}]);
 await h.cycle(1502,history,102);assert.equal(h.orders.length,0);assert.equal(h.persisted.length,1);assert.equal(h.persisted[0].orderId,'accepted-order');assert.equal(h.persisted[0].sl,96);assert.equal(h.persisted[0].tp,111);
});

test('settings UI keeps drafts unpersisted; saving a change forces OFF, approval alone can turn ON',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=require('react-dom/server'),dashboard=await import('../lib/dashboard');const f=fixture();await f.save('a',{AUTO_TRADE:true});await f.save('a',{VERIFIED:true});
 const values={...definitions.runtimeSettingDefaults(),...await f.repository.getRuntimeSettingOverrides('a')};
 const state:any[]=[{running:false,verified:true},false,'csrf',null,[],1,{page:1,totalPages:1,total:0},'Environment Variables',1,1,definitions.runtimeSettingMetadata(),values,values,false,false,''];let index=0;
 const component=execute('components/TradingDashboard.tsx',{'react/jsx-runtime':require('react/jsx-runtime'),react:{useState:(initial:any)=>{const key=index++;return [state[key]??initial,(value:any)=>{state[key]=typeof value==='function'?value(state[key]):value;}];},useEffect:()=>{}},'./AppModeBadge':{default:()=>null},'./DecisionLogRow':{default:()=>null},'../lib/dashboard':dashboard},{fetch:async(_url:string,options:any)=>{const body=JSON.parse(options.body);return f.save(body.portfolioId,body.values);}});
 const tree=()=>{index=0;return component.default({portfolioId:'a',appMode:'testing'});};
 const find=(node:any,predicate:(node:any)=>boolean):any=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const result=find(child,predicate);if(result)return result;}return null;};
 const button=(label:string)=>find(tree(),n=>n.type==='button'&&n.props.children===label);
 const risk=()=>find(find(tree(),n=>n.type==='label'&&String(n.key).endsWith('RISK_PCT')),n=>n.type==='input');
 const before=f.writes.length;button('Enable Edit').props.onClick();risk().props.onChange({target:{value:'0.5'}});assert.equal(f.writes.length,before);assert.equal((await f.repository.getRuntimeSettingOverrides('a')).VERIFIED,true);
 button('Cancel').props.onClick();assert.equal(f.writes.length,before);assert.equal(state[11].VERIFIED,true);
 button('Enable Edit').props.onClick();risk().props.onChange({target:{value:'0.5'}});await button('Save').props.onClick();assert.equal(state[11].VERIFIED,false);assert.equal(state[0].running,false);
 const html=renderToStaticMarkup(tree());assert.match(html,/role="switch"[^>]*aria-checked="false"/);assert.match(html,/verifiedToggle off/);
 button('Enable Edit').props.onClick();find(tree(),n=>n.props?.role==='switch').props.onClick();await button('Save').props.onClick();assert.equal(state[11].VERIFIED,true);assert.equal(f.controls.get('a'),false);
 const css=fs.readFileSync('app/style.css','utf8');assert.match(css,/\.verifiedToggle\.on\{background:#166534/);assert.match(css,/\.portfolioRobotDot\.running\{animation:portfolioRobotPulse/);assert.match(css,/\.portfolioRobotDot\.stopped\{background:#ff6363/);
});
test('status clamps stale running/pending after a save but retains current account and open-position data',async()=>{
 const {validateStatusMode}=await import('../lib/runtime/status-mode');const f=fixture();await f.save('a',{AUTO_TRADE:true});await f.save('a',{VERIFIED:true});await f.start('a');
 const saved=await f.repository.getRuntimeSettingsSnapshot('a'),snapshot={appMode:'testing',entryRevision:saved.entryRevision,running:true,pending:{trigger:101},position:{size:2,entryPrice:100},equity:1000,available:900,price:110,activeTrade:{sl:90,tp:120}};
 const reader=execute('lib/settings/status.ts',{'../app-mode':{getAppMode:()=> 'testing'},'../runtime/status-mode':{validateStatusMode},'./repository':f.repository,'./definitions':definitions,'../state':{readStatus:()=>snapshot,readControl:()=>({running:f.controls.get('a')})}});
 const route=execute('app/api/status/route.ts',{'../../../lib/settings/status':reader,'next/server':{NextResponse},'../../../lib/auth/api':{requireApiSession:async()=>({ok:true})},'../../../lib/portfolio/access':{resolvePortfolioId:async()=>({_id:{toHexString:()=> 'a'}})}});
 await f.save('a',{RISK_PCT:0.5});const response=await route.GET(new NextRequest('http://localhost/api/status?portfolioId=a')),status=await response.json();assert.equal(status.running,false);assert.equal(status.pending,null);assert.equal(status.verified,false);assert.equal(status.equity,1000);assert.equal(status.available,900);assert.deepEqual(status.position,{size:2,entryPrice:100});assert.deepEqual(status.activeTrade,{sl:90,tp:120});
});

test('worker revocation inside a prepared entry callback prevents market dispatch and later replay',async()=>{
 const h=verificationWorker();await h.cycle(1502,history,102);
 h.onSettingsRead(read=>{if(read===5)h.settings({VERIFIED:false,AUTO_TRADE:true},'revoked-before-dispatch');});
 await assert.rejects(h.cycle(1802,[...history,{time:1500,open:100,high:100,low:100,close:100}],102),/ROBOT_STOPPED|ENVIRONMENT_NOT_VERIFIED|CONFIG_CHANGED/);
 assert.equal(h.intents.length,1);assert.equal(h.orders.length,0);assert.equal(h.inspect().pending,null);
 h.settings({VERIFIED:true,AUTO_TRADE:true},'reviewed-again');await h.refresh();h.start();await h.cycle(1803,[...history,{time:1500,open:100,high:100,low:100,close:100}],102);assert.equal(h.orders.length,0);
});
