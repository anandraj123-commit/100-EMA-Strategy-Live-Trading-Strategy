import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as dashboard from '../lib/dashboard';
import { ActiveTradeSummary } from '../components/TradingDashboard';
const {renderToStaticMarkup}=require('react-dom/server');
(globalThis as any).React=React;
const time='2026-09-20T10:00:00.000Z';
const trade:any={tradeId:'trade-a',portfolioId:'a',source:'bot',symbol:'XAUTUSD',side:'LONG',status:'OPEN',attributionStatus:'BOT_CONFIRMED',actualEntryPrice:4370.3,entryTime:time,exitTime:null,initialSL:4300,currentSL:4370,currentSLTriggerMethod:'mark_price',currentTargetTriggerMethod:'spot_price',takeProfit:4500,currentTarget:4580,slHistory:[{previousValue:4300,value:4370,modifiedAt:time}],targetHistory:[{previousValue:4500,value:4580,modifiedAt:time}],remainingContracts:6,positionNotional:500,effectiveLeverage:10,marginUsed:50,marginUsedPct:50,entrySlippagePct:.04,entrySlippageAmount:1.8,entrySpreadPct:.03,entrySpreadAmount:1,entryFillIds:['e1','e2'],exitFillIds:['x1'],protectionSlOrderId:'sl',protectionTpOrderId:'tp'};
const summary=(record:any=trade,size=6,portfolioId='a')=>renderToStaticMarkup(<ActiveTradeSummary trade={record} positionSize={size} portfolioId={portfolioId}/>);
test('no position shows NO ACTIVE TRADE without fake price/protection fields',()=>{const html=summary(null,0);assert.match(html,/NO ACTIVE TRADE/);assert.doesNotMatch(html,/Entry Price|Initial SL|Initial Target/);});
for(const source of ['bot','exchange_existing'])test(`${source} summary shows authoritative entry, protection, execution and exposure, with no trading controls`,()=>{
 const html=summary({...trade,source,attributionStatus:source==='bot'?'BOT_CONFIRMED':'MANUAL_CONFIRMED'});
 for(const text of [source==='bot'?'ALGO':'MANUAL','XAUTUSD','LONG','OPEN','Entry Price','Entry Time','Exit Time','Initial SL','Current/Latest SL','Latest SL Modification Time','Initial Target','Current/Latest Target','Latest Target Modification Time','Actual/Effective Leverage','Position Quantity','Position Exposure/Notional','Margin/Capital Used','Entry Slippage','Entry Spread','4,370.3','4,300','4,370','4,500','4,580','10x','500','50%'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/<button|<input|<select|<form|slHistory|targetHistory/);
});
test('wrong portfolio, unknown and closed lifecycle are never displayed as owned active trades',()=>{
 for(const html of [summary(trade,6,'b'),summary({...trade,attributionStatus:'UNKNOWN'}),summary({...trade,status:'CLOSED'})]){assert.doesNotMatch(html,/4,370.3|ALGO/);assert.match(html,/OWNERSHIP UNCONFIRMED/);}
});
test('missing execution/margin history remains N/A',()=>{const html=summary({...trade,entrySlippagePct:null,entrySlippageAmount:null,entrySpreadPct:null,entrySpreadAmount:null,effectiveLeverage:null,marginUsed:null});assert.ok((html.match(/N\/A/g)??[]).length>=6);});
function renderDashboard(status:any,tab='Active Trade'){
 let index=0;const state:any[]=[status,false,'',null,[],1,{page:1,totalPages:1,total:0},tab,1,1,[],{},{},false,false,'',false];
 const modules:any={'react/jsx-runtime':require('react/jsx-runtime'),react:{useState:(initial:any)=>[state[index++]??initial,()=>{}],useEffect:()=>{}},'./BacktestingOptimisation':{default:()=>null},'./AppModeBadge':{default:()=>null},'./DecisionLogRow':{default:()=>null},'../lib/dashboard':dashboard};
 const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/TradingDashboard.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(name:string)=>modules[name]});
 return renderToStaticMarkup(module.exports.default({portfolioId:'a',appMode:'testing'}));
}
test('existing Active Trade JSON tab remains and renders complete histories from the same status lifecycle',()=>{
 const html=renderDashboard({activeTrade:trade,position:{size:6},connection:{state:'online'}});
 for(const field of ['currentSLTriggerMethod','currentTargetTriggerMethod','slHistory','targetHistory','previousValue','entryFillIds','exitFillIds','protectionSlOrderId','protectionTpOrderId','actualEntryPrice','entryTime','exitTime','initialSL','currentSL','takeProfit','currentTarget','remainingContracts','positionNotional','effectiveLeverage','marginUsed','entrySlippagePct','entrySpreadAmount'])assert.ok(html.includes(field),field);
 assert.match(html,/aria-label="Active Trade summary"/);assert.match(html,/>Active Trade<\/button>/);assert.match(html,/<pre>/);
});
test('live spread remains visible without a trade and updates independently of historical entry spread',()=>{
 const base={position:{size:0},activeTrade:null,connection:{state:'online'}};
 const first=renderDashboard({...base,spread:{amount:2,pct:2}}),next=renderDashboard({...base,spread:{amount:4,pct:4}});
 assert.match(first,/Spread/);assert.match(first,/2 \(2.0000%\)/);assert.match(next,/4 \(4.0000%\)/);assert.match(first,/NO ACTIVE TRADE/);
 assert.match(renderDashboard({...base,spread:null}),/Spread[\s\S]*?N\/A/);
});
