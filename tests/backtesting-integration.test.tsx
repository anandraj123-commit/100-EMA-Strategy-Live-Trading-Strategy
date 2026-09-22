import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
const { renderToStaticMarkup } = require('react-dom/server');
import BacktestingOptimisation from '../components/BacktestingOptimisation';
import * as integration from '../lib/backtesting/integration';
import { createTransferGate, environmentDraft, fieldMap, researchDefaults } from '../lib/backtesting/integration';
import view from '../lib/backtesting/reference-view.json';
import * as dashboard from '../lib/dashboard';

const reference = fs.readFileSync('reference/backtesting-optimisation.html', 'utf8');
const script = reference.split('<script>')[1].split('</script>')[0];
const runtime = fs.readFileSync('lib/backtesting/reference-runtime.ts', 'utf8');
const saved = { RESOLUTION:'5m', EMA_LENGTH:75, SLOPE_LOOKBACK:3, ENTRY_VALID_CANDLES:2, RR:3, RISK_PCT:1, GST_PCT:18, MAX_DAILY_CONSECUTIVE_LOSSES:2, MIN_STOP_PCT:0.3, MAX_EFFECTIVE_LEVERAGE:10, MAX_FEE_RISK_PCT:20, VERIFIED:true, AUTO_TRADE:true };
const params = { emaLen:5, slopeLookback:2, entryValidCandles:2, rr:2, riskPct:1, startCapital:10000, commissionPct:0.05, gstPct:18, maxLossesPerDay:2, minStopPct:0, maxLeverage:100, maxFeeRiskPct:100, strategyResolutionSeconds:300 };
const candles = Array.from({length:180}, (_,i) => {
  const close = 100 + Math.sin(i * 0.7) * 9;
  return {time:86400+i*300, open:100+Math.sin((i-1)*0.7)*9, high:close+5, low:close-5, close};
});
const minutes = candles.flatMap(c => Array.from({length:5}, (_,i) => ({...c,time:c.time+i*60})));
function harness(integrated: boolean, failFetch = false, cancel = false) {
  const nodes: Record<string, any> = {};
  for (const match of view.body.matchAll(/<(?:input|button|div|tbody|canvas)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    nodes[match[1]] = {value:tag.match(/value="([^"]+)"/)?.[1]||'', disabled:tag.includes(' disabled'), style:{}, innerHTML:'',textContent:'',handlers:{} as Record<string, Function>,addEventListener(event:string,fn:Function){this.handlers[event]=fn;}};
  }
  const calls: string[] = [], events: string[] = [];
  const context = vm.createContext({document:{getElementById:(id:string)=>nodes[id]},window:{devicePixelRatio:1},setTimeout:(fn:Function)=>{if(cancel)nodes.optCancelBtn.handlers.click();fn();},fetch:async(url:string)=>{calls.push(url);if(failFetch)throw Error("fixture transport failure");return {ok:true,json:async()=>({result:url.includes('resolution=1m&')?minutes:candles})};},bridge:{begin(){events.push('begin');},ranked(){events.push('ranked');},complete(){events.push('complete');},invalidate(){events.push('invalidate');},applyingBest(){return ()=>{};}}});
  const exports = '({computeEMA,runBacktest,buildOneMinuteIndex,numericRange,combinationCount,comboFromIndex,sampledIndices,renderOptimizerResults,fetchCandles})';
  if (integrated) vm.runInContext(runtime.replace('export function mountReference','function mountReference').replace('return { dispose()',`globalThis.engine = ${exports};\nreturn { dispose()`)+'\nmountReference(document,bridge);',context);
  else vm.runInContext(script+`\nglobalThis.engine = ${exports};`,context);
  return { engine:context.engine,nodes,calls,events,mount:context.mountReference };
}
const plain = (x:unknown) => JSON.parse(JSON.stringify(x));

test('reference fields, order, labels, defaults, panels, tables and CSS are retained; React host renders',()=>{
  assert.equal(view.body,reference.split('<body>')[1].split('<script>')[0].trim());
  assert.equal(view.css,reference.split('<style>')[1].split('</style>')[0].replace(':root{',':host{').replace('  body{','  .reference-body{'));
  (globalThis as any).React=React;
  assert.match(renderToStaticMarkup(<BacktestingOptimisation portfolioId="a" symbol="BTCUSD" saved={saved} onTransfer={()=>assert.fail('render must not transfer')}/>),/Backtesting &amp; Optimisation/);
});

test('identical candles and configurations produce exactly equal complete trades, equity and statistics',()=>{
  const a=harness(false).engine,b=harness(true).engine;
  let trades=0;
  for(const emaLen of [5,75,100]) for(const rr of [1,3]) for(const entryValidCandles of [1,2,4]) {
    const p={...params,emaLen,rr,entryValidCandles};
    for(const data of [minutes,minutes.filter((_,i)=>i%7!==0),[]]) {
      const expected=a.runBacktest(candles,p,a.buildOneMinuteIndex(data,300));
      const actual=b.runBacktest(candles,p,b.buildOneMinuteIndex(data,300));
      assert.deepEqual(plain(actual),plain(expected));trades+=actual.trades.length;
    }
  }
  assert.ok(trades>0);
  assert.deepEqual(plain(b.computeEMA([1,2,3,4,5],3)),plain(a.computeEMA([1,2,3,4,5],3)));
});

test('optimizer sampling, trials, filtering, ranking and rendered results equal the reference',async()=>{
  const a=harness(false),b=harness(true);
  for(const h of [a,b]) {
    for(const [id,value] of Object.entries({emaLen:5,slopeLookback:2,startDate:'1970-01-02',endDate:'1970-01-02',optEmaMin:5,optEmaMax:10,optEmaStep:5,optSlopeMin:1,optSlopeMax:2,optMaxTrials:30,optMinTrades:1})) h.nodes[id].value=String(value);
    await h.nodes.optimizeBtn.handlers.click();
    assert.match(h.nodes.optProgressText.textContent,/Optimization complete/);
    assert.ok(h.nodes.optimizerTableBody.innerHTML.includes('<tr>'));
  }
  assert.deepEqual(a.calls,b.calls);
  for(const id of ['optimizerTableBody','bestBox'])assert.equal(a.nodes[id].innerHTML,b.nodes[id].innerHTML);
  assert.equal(a.nodes.optProgressText.textContent,b.nodes.optProgressText.textContent);
  for(const [total,max] of [[10,20],[1000,17],[100,1]])assert.deepEqual(plain(a.engine.sampledIndices(total,max)),plain(b.engine.sampledIndices(total,max)));
  assert.deepEqual(b.events,['begin','ranked','complete']);
  a.nodes.applyBestBtn.handlers.click();b.nodes.applyBestBtn.handlers.click();
  for(const field of Object.keys(fieldMap).filter(k=>k!=='resolution'))assert.equal(a.nodes[field].value,b.nodes[field].value);
});

test('saved defaults and transfer whitelist exclude research statistics, identity and live controls',()=>{
  const defaults=researchDefaults(saved,'ETHUSD');
  assert.equal(defaults.emaLen,'75');assert.equal(defaults.symbol,'ETHUSD');assert.equal(defaults.startCapital,undefined);
  const result=environmentDraft({...params,VERIFIED:false,AUTO_TRADE:false,portfolioId:'b',startDate:'x'},'5m',saved)!;
  assert.deepEqual(Object.keys(result).sort(),Object.values(fieldMap).sort());
  assert.equal(result.EMA_LENGTH,5);assert.equal(saved.VERIFIED,true);assert.equal(saved.AUTO_TRADE,true);
  assert.equal(environmentDraft({...params,rr:NaN},'5m',saved),null);
});

test('transfer uses runtime best or selected result only for successful current run, unchanged context and same portfolio',()=>{
  let context='initial';const a=createTransferGate('a',()=>context),b=createTransferGate('b',()=>context);
  const row={params,stats:{totalReturn:10,maxDD:2,totalTrades:3}};
  assert.equal(a.applicable('a'),null);
  a.begin();a.ranked(() => row);a.select(0);assert.equal(a.applicable('a'),null);
  a.complete(true);a.select(0);assert.equal(a.applicable('a'),null);
  a.begin();a.ranked(() => row);a.invalidate();a.select(0);assert.equal(a.applicable('a'),null);
  a.begin();a.ranked(() => row);a.complete(false);assert.equal(a.applicable('a'),row);
  a.select(0);assert.equal(a.applicable('a'),row);assert.equal(a.applicable('b'),null);assert.equal(b.applicable('b'),null);
  context='changed';assert.equal(a.applicable('a'),null);
  a.begin();a.ranked(() => row);a.complete(false);assert.equal(a.applicable('a'),row);
  a.select(0);a.begin();assert.equal(a.applicable('a'),null);
  a.ranked(() => ({...row,stats:{...row.stats,totalReturn:NaN}}));a.complete(false);a.select(0);assert.equal(a.applicable('a'),null);
});

test('same-portfolio transfer opens unsaved existing settings editor; discard has no live side effects',()=>{
  const state:any[]=[{running:true,verified:true,position:{size:2}},false,'csrf',null,[],1,{page:1,totalPages:1,total:0},'Backtesting & Optimisation',1,1,[{key:'RR',label:'RR',type:'number'},{key:'VERIFIED',label:'Verified',type:'boolean'}],{...saved},{...saved},false,false,'',true];
  let index=0;const requests:any[]=[];
  const module={exports:{} as any};
  const source=ts.transpileModule(fs.readFileSync('components/TradingDashboard.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const modules:Record<string,any>={'react/jsx-runtime':require('react/jsx-runtime'),react:{useState:(initial:any)=>{const key=index++;return [state[key]??initial,(v:any)=>{state[key]=typeof v==='function'?v(state[key]):v;}];},useEffect:()=>{}},'./BacktestingOptimisation':{default:BacktestingOptimisation},'./AppModeBadge':{default:()=>null},'./DecisionLogRow':{default:()=>null},'../lib/dashboard':dashboard};
  vm.runInNewContext(source,{module,exports:module.exports,require:(key:string)=>modules[key],fetch:(...args:any[])=>{requests.push(args);throw Error('Unexpected persistence');}});
  const tree=()=>{index=0;return module.exports.default({portfolioId:'a',appMode:'testing',symbol:'BTCUSD'});};
  const find=(node:any,match:(node:any)=>boolean):any=>{if(!node||typeof node!=='object')return null;if(match(node))return node;for(const child of React.Children.toArray(node.props?.children)){const hit=find(child,match);if(hit)return hit;}return null;};
  const transfer=find(tree(),n=>n.type===BacktestingOptimisation).props.onTransfer;
  transfer('b',{RR:8});assert.equal(state[11].RR,3);
  transfer('a',{RR:8});assert.equal(state[11].RR,8);assert.equal(state[12].RR,3);assert.equal(state[7],'Environment Variables');assert.equal(state[13],true);
  assert.equal(state[11].VERIFIED,true);assert.equal(state[11].AUTO_TRADE,true);assert.equal(state[0].running,true);assert.equal(state[0].position.size,2);assert.deepEqual(requests,[]);
  find(tree(),n=>n.type==='button'&&n.props.children==='Cancel').props.onClick();assert.equal(state[11].RR,3);assert.deepEqual(requests,[]);
});


test('failed and cancelled reference optimizer runs invalidate transfer and never report successful completion',async()=>{
  for(const [fail,cancel] of [[true,false],[false,true]]) {
    const h=harness(true,fail,cancel);
    h.nodes.startDate.value='1970-01-02';h.nodes.endDate.value='1970-01-02';
    await h.nodes.optimizeBtn.handlers.click();
    assert.ok(h.events.includes('invalidate'));
    assert.ok(!h.events.includes('complete'));
    assert.equal(h.nodes.applyBestBtn.disabled,true);
    assert.match(h.nodes.optProgressText.textContent,/Optimization stopped/);
  }
});

test('candle proxy forwards only the unchanged reference Delta request and response, without credentials',async()=>{
  const {NextRequest,NextResponse}=await import('next/server');
  const module={exports:{} as any},calls:any[]=[];
  const source=ts.transpileModule(fs.readFileSync('app/api/backtesting/candles/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  let authorized=true;
  vm.runInNewContext(source,{module,exports:module.exports,URL,Response,require:(id:string)=>id==='next/server'?{NextResponse}:{requireApiSession:async()=>authorized?{ok:true}:{ok:false,error:NextResponse.json({error:'Unauthorized'},{status:401})}},fetch:async(url:string,options:unknown)=>{calls.push([url,options]);return new Response(JSON.stringify({result:candles}),{status:200,headers:{'content-type':'application/json'}});}});
  for(const origin of ['https://api.india.delta.exchange','https://api.delta.exchange']){
    const upstream=`${origin}/v2/history/candles?resolution=5m&symbol=BTCUSD&start=86400&end=172799`;
    const response=await module.exports.GET(new NextRequest(`http://localhost/api/backtesting/candles?upstream=${encodeURIComponent(upstream)}`));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:candles});assert.equal(calls.at(-1)[0],upstream);
    assert.deepEqual(plain(calls.at(-1)[1]),{headers:{Accept:'application/json'},cache:'no-store',redirect:'error'});
  }
  const count=calls.length;
  for(const upstream of ['http://localhost/secrets','https://api.india.delta.exchange/v2/orders','https://api.india.delta.exchange/v2/history/candles?api_key=secret']){
    assert.equal((await module.exports.GET(new NextRequest(`http://localhost/api/backtesting/candles?upstream=${encodeURIComponent(upstream)}`))).status,400);
  }
  authorized=false;assert.equal((await module.exports.GET(new NextRequest('http://localhost/api/backtesting/candles'))).status,401);assert.equal(calls.length,count);
});


// Mount the actual component effects against a small DOM fixture. The real reference
// runtime and handlers run; only the browser DOM and external candle transport are fixtures.
function mountedResearch(fail = false, cancel = false, symbol = 'BTCUSD') {
  const h=harness(true,fail,cancel);
  const element=()=>({disabled:false,textContent:'',style:{},handlers:{} as Record<string,Function>,attributes:{} as Record<string,string>,
    addEventListener(name:string,fn:Function){this.handlers[name]=fn;},removeEventListener(name:string){delete this.handlers[name];},
    setAttribute(name:string,value:string){this.attributes[name]=value;},append(){},remove(){}});
  const button=element(),heading={firstChild:{textContent:'BTCUSD'},suffix:' // 5M SIGNAL · 1M EXECUTION BACKTESTER'};
  const fields=Array.from(view.body.matchAll(/<input\b[^>]*\bid="([^"]+)"/g),m=>Object.assign(h.nodes[m[1]],{id:m[1]}));
  let rendered='',rows:ReturnType<typeof element>[]=[];
  const getRows=()=>{const html=h.nodes.optimizerTableBody.innerHTML;if(html!==rendered){rendered=html;rows=Array.from(html.matchAll(/<tr>/g),()=>element());}return rows;};
  const root={...element(),innerHTML:'',getElementById:(id:string)=>h.nodes[id],
    querySelector:(selector:string)=>selector==='header h1'?heading:selector==='.optimizer-actions'?{insertBefore(){}}:{},
    querySelectorAll:(selector:string)=>selector==='input'?fields:getRows()};
  const document={getElementById:()=>({}),createElement:(tag:string)=>tag==='button'?button:tag==='div'?{...element(),attachShadow:()=>root}:element()};
  const effects:Function[]=[],props={portfolioId:'a',symbol,saved,onTransfer:(id:string,draft:unknown)=>transfers.push({id,draft})},transfers:any[]=[];
  let refs=0;
  const module={exports:{} as any},source=ts.transpileModule(fs.readFileSync('components/BacktestingOptimisation.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const modules:Record<string,any>={'react/jsx-runtime':require('react/jsx-runtime'),react:{useRef:(initial:any)=>({current:refs++===0?{replaceChildren(){}}:initial}),useEffect:(effect:Function)=>effects.push(effect)},'../lib/backtesting/reference-view.json':view,'../lib/backtesting/integration':integration,'../lib/backtesting/reference-runtime':{mountReference:(doc:any,bridge:any)=>h.mount(doc,bridge)}};
  vm.runInNewContext(source,{module,exports:module.exports,document,require:(id:string)=>{assert.ok(id in modules,id);return modules[id];}});
  module.exports.default(props);effects.forEach(effect=>effect());
  for(const [id,value] of Object.entries({emaLen:5,slopeLookback:2,startDate:'1970-01-02',endDate:'1970-01-02',optEmaMin:5,optEmaMax:10,optEmaStep:5,optSlopeMin:1,optSlopeMax:2,optMaxTrials:30,optMinTrades:1}))h.nodes[id].value=String(value);
  return {...h,button,root,heading,transfers,props,getRows};
}

test('mounted transfer button follows actual optimizer best/selection, reruns and invalidation',async()=>{
  const h=mountedResearch();
  assert.equal(h.button.disabled,true); // A
  const run=h.nodes.optimizeBtn.handlers.click();
  assert.equal(h.button.disabled,true);
  await run;
  assert.match(h.nodes.bestBox.innerHTML,/BEST NET RETURN/);
  assert.equal(h.button.disabled,false); // B: no extra row click required
  assert.equal(h.getRows()[0].attributes['aria-selected'],'true');
  h.button.handlers.click(); // C: exact runtime result, whitelisted draft only
  h.nodes.applyBestBtn.handlers.click();
  const expectedParams=Object.fromEntries(Object.keys(fieldMap).filter(k=>k!=='resolution').map(k=>[k,Number(h.nodes[k].value)]));
  assert.deepEqual(h.transfers,[{id:'a',draft:environmentDraft(expectedParams,h.nodes.resolution.value,saved)}]);
  assert.equal(h.button.disabled,false);
  const rerun=h.nodes.optimizeBtn.handlers.click();assert.equal(h.button.disabled,true);
  h.button.handlers.click();assert.equal(h.transfers.length,1);await rerun;
  assert.equal(h.button.disabled,false);
  h.getRows()[1].handlers.click();h.button.handlers.click();
  const selectedCells=Array.from(String(h.nodes.optimizerTableBody.innerHTML).matchAll(/<tr>([\s\S]*?)<\/tr>/g))[1][1];
  const cells=Array.from(selectedCells.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g),m=>m[1]);
  assert.ok(h.transfers[1].draft);
  assert.equal(h.transfers[1].draft.EMA_LENGTH,Number(cells[6]));assert.equal(h.transfers[1].draft.RR,Number(cells[9]));
  h.props.portfolioId='b';h.button.handlers.click();assert.equal(h.transfers.length,2);h.props.portfolioId='a';
  h.nodes.rr.value='9';h.root.handlers.input();assert.equal(h.button.disabled,true);
  h.button.handlers.click();assert.equal(h.transfers.length,2);
  const invalidatedRun=h.nodes.optimizeBtn.handlers.click();h.root.handlers.input();await invalidatedRun;
  assert.equal(h.button.disabled,true);
  assert.equal(saved.VERIFIED,true);assert.equal(saved.AUTO_TRADE,true);
});

test('mounted transfer stays disabled for failed, cancelled and empty optimizer results',async()=>{
  for(const [fail,cancel,empty] of [[true,false,false],[false,true,false],[false,false,true]]){
    const h=mountedResearch(fail,cancel);
    if(empty)h.nodes.optMinTrades.value='1000000';
    await h.nodes.optimizeBtn.handlers.click();
    assert.equal(h.button.disabled,true);h.button.handlers.click();assert.deepEqual(h.transfers,[]);
  }
});

test('heading immediately follows authoritative BTCUSD/XAUTUSD/XRPUSD input and candle request symbol',async()=>{
  const h=mountedResearch(false,false,'XAUTUSD');
  assert.equal(h.heading.firstChild.textContent,'XAUTUSD');
  for(const symbol of ['BTCUSD','XAUTUSD','XRPUSD']){
    h.nodes.symbol.value=` ${symbol} `;h.root.handlers.input();
    assert.equal(h.heading.firstChild.textContent+h.heading.suffix,`${symbol} // 5M SIGNAL · 1M EXECUTION BACKTESTER`);
    h.calls.length=0;await h.nodes.optimizeBtn.handlers.click();
    assert.ok(h.calls.length>0);
    assert.ok(h.calls.every(url=>new URL(url).searchParams.get('symbol')===h.heading.firstChild.textContent));
    // Run Backtest reads the same input independently of optimizer market inputs.
    h.nodes.emaLen.value='1000';h.calls.length=0;await h.nodes.runBtn.handlers.click();
    assert.ok(h.calls.length>0);
    assert.ok(h.calls.every(url=>new URL(url).searchParams.get('symbol')===h.heading.firstChild.textContent));
    h.nodes.emaLen.value='5';
  }
});


test('successful optimization → Apply Best Values preserves best and enabled unsaved transfer',async()=>{
  const h=mountedResearch();
  assert.equal(h.button.disabled,true);
  await h.nodes.optimizeBtn.handlers.click();
  assert.equal(h.button.disabled,false);
  const bestHtml=h.nodes.bestBox.innerHTML;
  // Capture the authoritative transfer before applying, then prove exact identity of values.
  h.button.handlers.click();
  const bestDraft=h.transfers[0].draft;
  h.transfers.length=0;
  h.getRows()[1].handlers.click(); // Apply Best must select best even after another row was selected.
  h.nodes.applyBestBtn.handlers.click();
  assert.equal(h.nodes.bestBox.innerHTML,bestHtml);
  assert.equal(h.button.disabled,false);
  assert.equal(h.getRows()[0].attributes['aria-selected'],'true');
  for(const [field,key] of Object.entries(fieldMap)){
    if(field==='resolution')assert.equal(h.nodes[field].value,bestDraft[key]);
    else assert.equal(Number(h.nodes[field].value),bestDraft[key]);
  }
  h.button.handlers.click();
  assert.deepEqual(h.transfers,[{id:'a',draft:bestDraft}]);
  h.nodes.applyBestBtn.handlers.click(); // Reapplying is also harmless.
  assert.equal(h.button.disabled,false);
  h.nodes.optRrMax.value='12';h.root.handlers.input();
  assert.equal(h.button.disabled,true);
  h.nodes.applyBestBtn.handlers.click(); // Must not revive a manually invalidated result.
  assert.equal(h.button.disabled,true);
  h.button.handlers.click();assert.equal(h.transfers.length,1);
  const run=h.nodes.optimizeBtn.handlers.click();
  assert.equal(h.button.disabled,true);
  h.nodes.applyBestBtn.handlers.click();h.button.handlers.click();
  assert.equal(h.transfers.length,1);
  await run;
});

test('Apply Best context handoff rejects wrong portfolio, wrong best, stale context and intervening run',()=>{
  let context='original';
  const gate=createTransferGate('a',()=>context);
  const best={params,stats:{totalReturn:10,maxDD:2,totalTrades:3}};
  const start=()=>{gate.begin();gate.ranked(()=>best);gate.complete(false);};
  start();
  let finish=gate.applyingBest('b',best);context='applied';finish();assert.equal(gate.applicable('a'),null);
  start();finish=gate.applyingBest('a',{...best});context='wrong-result';finish();assert.equal(gate.applicable('a'),null);
  start();context='manually-stale';finish=gate.applyingBest('a',best);finish();assert.equal(gate.applicable('a'),null);
  start();finish=gate.applyingBest('a',best);gate.begin();finish();assert.equal(gate.applicable('a'),null);
  start();finish=gate.applyingBest('a',best);context='best-inputs';finish();assert.equal(gate.applicable('a'),best);
});
