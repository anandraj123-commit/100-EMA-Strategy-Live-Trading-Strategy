import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as strategy from '../../lib/strategy';
import * as pendingRules from '../../lib/pending';
import * as finalSafety from '../../lib/runtime/final-preorder';
import * as settings from '../../lib/settings/live';

// Execute the real worker cycle with all external I/O denied unless explicitly
// stubbed below. Only the top-level process launcher is removed, via the TS AST;
// no strategy/execution statements are rewritten or reproduced in the harness.
const source=fs.readFileSync(new URL('../../worker.ts',import.meta.url),'utf8');
const sourceFile=ts.createSourceFile('worker.ts',source,ts.ScriptTarget.ES2022,true);
const launcher=sourceFile.statements.at(-1)!;
assert.ok(ts.isExpressionStatement(launcher)&&ts.isVoidExpression(launcher.expression),'worker process launcher must remain explicit');
const workerWithoutLauncher=ts.createPrinter().printFile(ts.factory.updateSourceFile(sourceFile,sourceFile.statements.slice(0,-1)));
const executable=ts.transpileModule(workerWithoutLauncher+`
  runtimeEnvironment='demo'; runtimeProductId=27;
  runtimeFallbackSettings=runtimeConfigSnapshot();
  effectiveRuntimeSettings={...runtimeFallbackSettings};
  configRevision=runtimeSettingsRevision(effectiveRuntimeSettings);
  dailyLossStateReady=true; currentDay=tradingDayKey();
  module.exports={cycle, openTradeProtectionPriceSource, inspect:()=>({pending,activeTrade,uiLogs,tradeEvents}),
    refreshRuntimeSettings,
    seedExistingPosition:(size)=>{activeTrade={direction:size>0?'long':'short',positionSize:size,
      contracts:Math.abs(size),entryPrice:100,source:'exchange_existing',attributionStatus:'UNKNOWN',
      orderId:'existing-order',sl:90,tp:110};}};
`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

export function verificationWorker(options:{entryValidCandles?:number;emaLen?:number;slopeLookback?:number}={}) {
  let now=1_800_000, candles:strategy.Candle[]=[], price=100, running=true;
  let status:any;
  let confirmedIntents:any[]=[],reconciliationCount=0;
  const closed:any[]=[];
  let settingsValues:Record<string,any>={VERIFIED:true};
  let settingsRevision="legacy",settingsReads=0;
  let onRead:((read:number)=>void)|undefined;
  let positionSize=0;
  let failPersistence=false;
  const positionReads:number[]=[];
  const orders:any[]=[], brackets:any[]=[], intents:any[]=[], persisted:any[]=[], leverages:number[]=[];
  const config={env:'demo',apiKey:'test',apiSecret:'test',symbol:'XAUTUSD',resolution:'5m',resolutionSec:300,
    emaLen:2,slopeLookback:1,entryValidCandles:2,rr:2,riskPct:1,riskBase:'available',maxDailyLosses:10,
    minStopPct:0,maxEffectiveLeverage:100,maxFeeRiskPct:20,gstPct:18,orderLeverage:50,
    autoTrade:true,verified:true,priceSource:'last',pollMs:1000,candleHistoryBars:200,...options};
  const empty=async()=>[];
  const yes=async()=>true;
  const modules:Record<string,any>={
    './lib/config':{config,applyRuntimeConfigOverrides:(next:any)=>{
      const names:Record<string,string>={AUTO_TRADE:'autoTrade',VERIFIED:'verified',POLL_MS:'pollMs',RESOLUTION:'resolution',EMA_LENGTH:'emaLen',RR:'rr',RISK_PCT:'riskPct',PRICE_SOURCE:'priceSource'};
      for(const [key,name] of Object.entries(names))if(key in next)(config as any)[name]=next[key];
      config.resolutionSec=Number(config.resolution.slice(0,-1))*(config.resolution.endsWith('m')?60:3600);
    }},
    './lib/strategy':strategy,'./lib/pending':pendingRules,'./lib/runtime/final-preorder':finalSafety,
    './lib/settings/live':settings,
    './lib/settings/definitions':{validateRuntimeSettings:(values:any)=>values},
    './lib/settings/repository':{getRuntimeSettingsSnapshot:async()=>{onRead?.(++settingsReads);return {values:{...settingsValues},entryRevision:settingsRevision};}},
    './lib/state':{readControl:()=>({running}),writeControl:(control:any)=>{running=control.running;},writeStatus:(value:any)=>{status=value;}},
    './lib/delta':{
      getProduct:async()=>({id:27,state:'live',trading_status:'operational',contract_value:0.1,tick_size:0.5,taker_commission_rate:0.0005}),
      getTicker:async()=>({close:price,mark_price:price,spot_price:price}),
      getCandles:async()=>candles,getPosition:async()=>({size:positionReads.length?positionReads.shift():positionSize,entry_price:100}),
      getWallet:async()=>({meta:{net_equity:99999},result:[{asset_symbol:'USD',available_balance:1000}]}),
      setLeverage:async(_product:number,value:number)=>{leverages.push(value);},
      placeMarketOrder:async(productId:number,side:string,contracts:number,clientOrderId:string)=>{
        orders.push({productId,side,contracts,clientOrderId});
        positionSize=side==='buy'?contracts:-contracts;
        return {result:{id:'order-1',product_id:productId,client_order_id:clientOrderId,average_fill_price:price,fill_ids:['fill-1']}};
      },
      placeBracket:async(productId:number,sl:number,tp:number,triggerMethod:string)=>{brackets.push({productId,sl,tp,triggerMethod});}
    },
    './lib/trades/repository':{findUnresolvedBotTrades:empty,findUnresolvedManualTrades:empty,
      updateTradeProtectionState:async()=>{}},
    './lib/trades/persistence':{persistClosedTrade:async(trade:any)=>{closed.push(trade);return {tradeId:'existing',financialStatus:'actual'};},persistOpenBotTrade:async(trade:any)=>{if(failPersistence)throw new Error('test persistence unavailable');persisted.push({...trade});return {tradeId:'trade-1'};}},
    './lib/portfolio/deletion-state':{portfolioEntryAllowed:yes},
    './lib/portfolio/repository':{findPortfolioById:async()=>({_id:'contract',environment:'demo',symbol:'XAUTUSD',productId:27})},
    './lib/runtime/leases':{newLeaseOwner:()=> 'owner',portfolioEntryLeaseKey:()=> 'portfolio-entry',
      acquireAccountEntryLease:async()=>({key:'account',ownerId:'owner'}),acquireLease:async()=>({key:'portfolio',ownerId:'owner'}),
      releaseLease:yes,renewLease:yes,verifyLeaseOwnership:yes},
    './lib/runtime/entry-coordinator':{withExecutionActivity:async(_lease:any,_portfolio:string,task:any)=>task({ownershipLost:()=>false,assertOwnership:async()=>{}})},
    './lib/entry-intents/identity':{entryIntentId:()=> 'intent-1',entryClientOrderId:()=> 'client-1'},
    './lib/entry-intents/repository':{findRecoverableConfirmedEntryIntents:empty,findBlockingEntryIntent:async()=>null,markEntryIntentOwnershipPersisted:async()=>{}},
    './lib/entry-intents/service':{
      reconcilePortfolioEntryIntents:async()=>{reconciliationCount++;const confirmed=confirmedIntents;confirmedIntents=[];return {confirmed};},
      submitPreparedEntryIntent:async(intent:any,submit:any)=>{intents.push(intent);return {status:'CONFIRMED',order:await submit(intent.clientOrderId)};},
      EntryNotTransmittedError:class extends Error{}
    },
    './lib/risk/daily-loss-streak':{tradingDayKey:()=> 'test-day',dailyLossEntryAllowed:(ready:boolean,losses:number,max:number)=>ready&&losses<max},
    './lib/trades/reconciliation':{},'./lib/runtime/manager':{},'./lib/db/mongodb':{},
    './lib/runtime/supervision-health':{},'./lib/runtime/legacy-guard':{},'./lib/trades/protection':{protectionTriggerMethod:()=> 'last_traded_price'},
    './lib/trades/protection-reconciliation':{reconcileProtection:async()=>{}},'./lib/trades/open-bot-restoration':{}
  };
  const module={exports:{} as any};
  class Clock extends Date {
    constructor(value?:string|number){super(value===undefined?now:value);}
    static now(){return now;}
  }
  vm.runInNewContext(executable,{module,exports:module.exports,Date:Clock,console,
    process:{env:{PORTFOLIO_RUNTIME_ID:'contract'}},
    setTimeout:(callback:()=>void)=>{callback();return 0;},
    require:(name:string)=>{assert.ok(name in modules,`Unexpected worker import: ${name}`);return modules[name];}
  },{filename:'worker.contract.js'});
  return {
    config,orders,brackets,intents,persisted,leverages,closed,
    protectionSource:()=>module.exports.openTradeProtectionPriceSource(),
    confirmed:(intents:any[])=>{confirmedIntents=intents;},
    reconciliations:()=>reconciliationCount,
    settings:(values:Record<string,any>,revision:string)=>{settingsValues=values;settingsRevision=revision;},
    onSettingsRead:(callback:(read:number)=>void)=>{onRead=callback;},
    refresh:()=>module.exports.refreshRuntimeSettings(),
    failOpenPersistence:()=>{failPersistence=true;},
    existingPosition:(size:number)=>{positionSize=size;module.exports.seedExistingPosition(size);},
    setPosition:(size:number)=>{positionSize=size;},
    queuePositionReads:(...sizes:number[])=>{positionReads.push(...sizes);},
    inspect:()=>module.exports.inspect(),status:()=>status,
    stop:()=>{running=false;},start:()=>{running=true;},
    async cycle(atSeconds:number,history:strategy.Candle[],livePrice:number){
      now=atSeconds*1000;candles=history;price=livePrice;await module.exports.cycle();
    }
  };
}
