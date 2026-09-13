import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { portfolioCardRuntime,PORTFOLIO_STATUS_MAX_AGE_MS } from '../lib/portfolio/card-status';
import PortfolioRuntimeIndicators from '../components/PortfolioRuntimeIndicators';
import { DELETE } from '../app/api/portfolio/route';
import { NextRequest } from 'next/server';
import { deletePortfolio } from '../lib/portfolio/repository';
import { deletePortfolioCoordinated } from '../lib/portfolio/deletion';
const {renderToStaticMarkup}=require('react-dom/server');
(globalThis as any).React=React;
const snapshot=(id:string,running:boolean,size:number,price=110)=>({portfolioId:id,appMode:'testing',updatedAt:new Date().toISOString(),connection:{state:'online'},running,autoTrade:true,position:{size,entryPrice:100},price,contractValue:1});
const render=(s:any,id='a')=>renderToStaticMarkup(<dl><PortfolioRuntimeIndicators runtime={portfolioCardRuntime(s,'testing',id)}/></dl>);
for(const running of [true,false])for(const size of [0,10,-10])for(const price of [90,100,110])test(`independent card state: running=${running} position=${size} price=${price}`,()=>{
 const state=portfolioCardRuntime(snapshot('a',running,size,price),'testing','a');
 const html=renderToStaticMarkup(<dl><PortfolioRuntimeIndicators runtime={state}/></dl>);
 assert.equal(state.running,running);assert.equal(state.trade,size===0?'FLAT':'OPEN');
 assert.match(html,new RegExp(`portfolioRobotDot ${running?'running':'stopped'}`));
 assert.match(html,new RegExp(`portfolioTradeStatus ${size===0?'flat':'open'}`));
 if(size===0){assert.equal(state.pnl,null);assert.match(html,/—/);}else{
   const value=(price-100)*size;assert.equal(state.pnl,value===0?0:value);
   assert.match(html,new RegExp(`portfolioPnl ${value===0?'neutral':value>0?'positive':'negative'}`));
   assert.ok(html.includes(`${value>0?'+':value<0?'-':''}$${Math.abs(value).toFixed(2)}`));
 }
});
test('unknown, cross-mode, stale, offline, wrong-portfolio and malformed snapshots never display open state or P/L',()=>{
 const valid=snapshot('a',true,10,12345);
 for(const s of [{...valid,appMode:'production'},{...valid,appMode:undefined},{...valid,updatedAt:new Date(Date.now()-PORTFOLIO_STATUS_MAX_AGE_MS-1).toISOString()},{...valid,updatedAt:'invalid'},{...valid,updatedAt:new Date(Date.now()+60000).toISOString()},{...valid,connection:{state:'offline'}},{...valid,portfolioId:'b'},{...valid,statusAvailable:false}]){
  const html=render(s);assert.doesNotMatch(html,/portfolioRobotDot running|>OPEN<|12345/);assert.match(html,/UNAVAILABLE/);assert.match(html,/—/);
 }
 for(const size of [undefined,null,'','invalid'])assert.equal(portfolioCardRuntime({...valid,position:{size}},'testing','a').trade,'UNAVAILABLE');
 const closed=portfolioCardRuntime({...valid,position:{size:0},activeTrade:{pnl:99999}},'testing','a');assert.equal(closed.pnl,null);assert.equal(closed.trade,'FLAT');
});
test('expired client summary cannot remain green even if polling has stopped',()=>{
 const html=renderToStaticMarkup(<dl><PortfolioRuntimeIndicators runtime={{running:true,trade:'OPEN',pnl:12345,expiresAt:Date.now()-1}}/></dl>);
 assert.doesNotMatch(html,/portfolioRobotDot running|>OPEN<|12345/);assert.match(html,/UNAVAILABLE/);
});
function execute(source:string,modules:Record<string,any>,globals:Record<string,any>={}){
 const module={exports:{} as any};const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,console,...globals,require:(name:string)=>{assert.ok(name in modules,name);return modules[name];}});return module.exports;
}
test('portfolio list attaches only each ID’s runtime and cards preserve fields and navigation without deletion UI',async()=>{
 const statuses:Record<string,any>={a:snapshot('a',true,10),b:snapshot('b',false,0),c:snapshot('c',false,2,90)};
 const reads:string[]=[];
 const service=execute(fs.readFileSync('lib/portfolio/service.ts','utf8'),{
  '../app-mode':{getAppMode:()=> 'testing',getDeltaConfig:()=>({environment:'demo'})},
  '../delta':{getPublicTicker:async()=>({close:100})},'./repository':{},
  '../settings/status':{readPortfolioRuntimeStatus:async(id:string)=>{reads.push(id);return statuses[id];}},'./card-status':{portfolioCardRuntime}
 });
 const rows=await service.portfolioWithPrices(['a','b','c'].map((id,i)=>({_id:{toHexString:()=>id},symbol:['BTCUSD','ETHUSD','XRPUSD'][i],productId:i+1,name:'Perpetual',contractValue:1,settlingAsset:'USD',underlyingAsset:'BTC',environment:'demo'})));
 assert.deepEqual(reads,['a','b','c']);assert.deepEqual(Array.from(rows,(r:any)=>({...r.runtime,expiresAt:0})),[
  {running:true,trade:'OPEN',pnl:100,expiresAt:0},{running:false,trade:'FLAT',pnl:null,expiresAt:0},{running:false,trade:'OPEN',pnl:-20,expiresAt:0}
 ]);
 let state=0,click:((event:any)=>void)|undefined;const paths:string[]=[];
 const manager=execute(fs.readFileSync('components/PortfolioManager.tsx','utf8'),{
  'react/jsx-runtime':require('react/jsx-runtime'),react:{useState:(value:any)=>[++state===1?rows:state===2?false:value,()=>{}],useRef:(value:any)=>({current:value}),useEffect:(effect:()=>void,deps:any[])=>{if(deps.length===2&&Array.isArray(deps[0]))effect();}},
  'next/navigation':{useRouter:()=>({push:(path:string)=>paths.push(path)})},
  './PortfolioRuntimeIndicators':{default:PortfolioRuntimeIndicators},'./PortfolioCreationFields':{default:()=>null}
 },{document:{addEventListener:(_name:string,handler:any)=>{click=handler;}}});
 const html=renderToStaticMarkup(manager.default({appMode:'testing'}));
 for(const text of ['FUTURES','BTCUSD','ETHUSD','XRPUSD','Perpetual','Current Price','Product ID','Contract Value','Application Mode','Settling Asset','Underlying Asset','+$100.00','-$20.00'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/portfolioRobotDot running/g)||[]).length,1);assert.equal((html.match(/portfolioRobotDot stopped/g)||[]).length,2);
 assert.equal((html.match(/portfolioTradeStatus open/g)||[]).length,2);assert.equal((html.match(/portfolioTradeStatus flat/g)||[]).length,1);
 assert.doesNotMatch(html,/DELETE|DELETING|trash|confirm|portfolioDelete/i);
 for(const id of ['a','b','c'])click!({target:{closest:(selector:string)=>selector==='button'?null:{getAttribute:()=>id}}});
 assert.deepEqual(paths,['/futures/dashboard/a','/futures/dashboard/b','/futures/dashboard/c']);
 const source=fs.readFileSync('components/PortfolioManager.tsx','utf8');assert.doesNotMatch(source,/method:\s*['"]DELETE|window.confirm|deleting|portfolio-delete|deleteDisabled/);
});
test('API, service and repository deletion attempts perform no I/O or removal',async()=>{
 const previous=(globalThis as any).mongoClientPromise;let touched=0;
 (globalThis as any).mongoClientPromise=Promise.resolve({db:()=>{touched++;throw new Error('Unexpected database access');}});
 try{
  const response=await DELETE(new NextRequest('http://localhost/api/portfolio',{method:'DELETE',body:JSON.stringify({id:'aaaaaaaaaaaaaaaaaaaaaaaa'})}));
  assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET, POST');assert.match((await response.json()).error,/deletion is not allowed/);
  assert.equal(await deletePortfolio('aaaaaaaaaaaaaaaaaaaaaaaa'),false);
  assert.deepEqual(await deletePortfolioCoordinated({},async()=>{touched++;return true;},new Proxy({},{get:()=>{touched++;throw new Error('Unexpected side effect');}})),{ok:false,reason:'PORTFOLIO_DELETION_NOT_ALLOWED'});
  assert.equal(touched,0);
 }finally{if(previous===undefined)delete (globalThis as any).mongoClientPromise;else (globalThis as any).mongoClientPromise=previous;}
});
