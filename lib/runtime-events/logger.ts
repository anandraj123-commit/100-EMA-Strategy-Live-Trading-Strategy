import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeEventType } from '../../models/RuntimeEvent';
import { sanitize } from './sanitizer';
import { persistRuntimeWrite, type RuntimeWrite } from './repository';

type Scope={portfolioId:string;symbol?:string};
export type Observation=Scope&(
  {kind:'decision';resolution:string;row:any;settings:any}|
  {kind:'event';event:string;data:any;context?:any;eventType?:RuntimeEventType;identity?:string}|
  {kind:'trade';record:any}|
  {kind:'robot';running:boolean;previous:boolean} );
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const literal=(value:unknown)=>({$literal:value});
// Only observation noise is excluded from transition identity, never from stored data.
export function meaningful(value:any):any {
  if(value instanceof Date)return value;
  if(Array.isArray(value))return value.map(meaningful);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key=>![
    'at','observedAt','updatedAt','reconciledAt','lastObservedAt','attemptedAt','protectionUpdatedAt','lifecycleRevision',
    'currentPrice','lastPrice','markPrice','breakoutPrice','breakoutPriceObservedAt','detectedAt',
    'positionNotional','effectiveLeverage','marginUsed','marginUsedPct',
  ].includes(key)).map(key=>[key,meaningful(value[key])]));
}
export function decisionState(row:any){
  const runtime=row.runtimeObservation;
  return meaningful({decision:row.decision,executionDecision:row.executionDecision,observationBlockReason:row.observationBlockReason,
    strategyLifecycle:row.strategyLifecycle,pending:row.pending,setup:row.setup,entryStage:row.entryStage,
    order:row.order,guards:row.guards,
    runtime:runtime?{positionOpen:runtime.positionOpen,newEntryAllowed:runtime.newEntryAllowed,blockReason:runtime.blockReason,
      robotRunning:runtime.robotRunning,autoTrade:runtime.autoTrade,stage:runtime.stage,position:runtime.position,exit:runtime.exit}:undefined});
}
export function categorize(event:string,data:any):RuntimeEventType {
  if(/PROTECTION|BRACKET|^(SL|TP)_/.test(event))return 'PROTECTION';
  if(data?.error||/FAILED|ERROR|CONNECTION_LOST|LEASE_LOST/.test(event))return 'ERROR';
  if(/RECONCIL|SYNC|ADOPT|ATTRIBUTION|RESTOR|POSITION_CLOSED/.test(event))return 'SYNC';
  if(/RUNTIME_|STRATEGY_STATE|CONNECTION_RESTORED/.test(event))return 'ROBOT';
  return 'TRADE';
}

export class RuntimeRecorder {
  private queue:{write:RuntimeWrite;bytes:number;coalesce?:string}[]=[];
  private bytes=0;
  private active=false;
  private scheduled=false;
  private seen=new Map<string,string>();
  private settings=new Map<string,any>();
  readonly diagnostics={dropped:0,failed:0,written:0};
  constructor(private sink:(write:RuntimeWrite)=>Promise<void>=persistRuntimeWrite,private now=()=>new Date(),private limit=512){}
  private remember(map:Map<string,any>,key:string,value:any){if(map.size>=1024&&!map.has(key))map.delete(map.keys().next().value!);map.set(key,value);}
  observe(input:Observation):void {
    try{
      if(!input.portfolioId)return;
      const observation=sanitize(input) as Observation,now=this.now();
      const scope={portfolioId:observation.portfolioId,...(observation.symbol?{symbol:observation.symbol}:{})};
      if(observation.kind==='decision'){
        const {row}=observation;
        const observationKey=hash([scope,row.candleTime,row.loggedAt]);
        if(!this.settings.has(observationKey))this.remember(this.settings,observationKey,{resolution:observation.resolution,settings:observation.settings});
        const {resolution,settings:settingsSnapshot}=this.settings.get(observationKey);
        // Incomplete presentation patches are not strategy evaluations.
        if(!row.candle||!row.loggedAt||!Number.isFinite(row.candleTime))return;
        const candleStartTime=new Date(row.candleTime*1000);
        const filter={...scope,eventType:'DECISION',resolution,candleStartTime};
        const key=hash(filter),state=decisionState(row),signature=hash(state);

        const correlationId=`signal:${scope.portfolioId}:${scope.symbol}:${resolution}:${row.strategyLifecycle?.signalCandleTime??row.candleTime}`;
        const changed={$ne:[{$ifNull:['$stateSignature',null]},literal(signature)]};
        this.enqueue({filter,update:[{$set:{...Object.fromEntries(Object.entries(filter).map(([k,v])=>[k,literal(v)])),
          event:literal('DECISION_UPDATED'),current:literal(row),correlationId:literal(correlationId),
          settingsSnapshot:{$ifNull:['$settingsSnapshot',literal(settingsSnapshot)]},
          createdAt:{$ifNull:['$createdAt',literal(now)]},updatedAt:literal(now),
          history:{$cond:[changed,{$concatArrays:[{$ifNull:['$history',[]]},literal([{at:now,state}])]},{$ifNull:['$history',[]]}]},
          stateSignature:literal(signature)}}]},`${key}:${signature}`);
      }else if(observation.kind==='robot'){
        if(observation.previous===observation.running)return;
        this.event(scope,observation.running?'ROBOT_STARTED':'ROBOT_STOPPED','ROBOT',
          {running:observation.running,previous:observation.previous},now,randomUUID());
      }else if(observation.kind==='trade'){
        const record=observation.record;
        if(record.portfolioId!==scope.portfolioId||!record.tradeId)return;
        const {protectionState:_protection,protectionSubmissions:_submissions,slHistory:_slHistory,targetHistory:_tpHistory,
          currentSL:_sl,currentTarget:_tp,protectionSlOrderId:_slId,protectionTpOrderId:_tpId,...execution}=record;
        const state=meaningful(execution);
        this.event(scope,'TRADE_LIFECYCLE_UPDATED','TRADE',record,now,hash([record.tradeId,state]));
      }else{
        const data={...observation.data,...(observation.context?{context:observation.context}:{})};
        const type=observation.eventType??categorize(observation.event,observation.data);
        const {id:_presentationId,at:_presentationTime,...identityData}=observation.data??{};
        const identity=observation.identity??hash([observation.event,meaningful(identityData),
          type==='ERROR'?Math.floor(now.valueOf()/300_000):null,
          observation.context?.tradeId??null,observation.context?.signalCandleTime??null]);
        this.event(scope,observation.event,type,data,now,identity);
      }
    }catch{this.diagnostics.dropped++;}
  }
  private event(scope:Scope,event:string,eventType:RuntimeEventType,data:any,now:Date,identity:string){
    const key=hash([scope,event,identity]);
    const tradeId=data.tradeId??data.context?.tradeId;
    const stateful=['POSITION_RECONCILED','PROTECTION_STATE_OBSERVED','ROBOT_EXECUTION_STATE','TRADE_LIFECYCLE_UPDATED'].includes(event)||eventType==='ERROR';
    const streamKey=hash([scope,event,tradeId??null]);
    // State streams suppress consecutive equality, not genuine A -> B -> A changes.
    if(stateful?this.seen.get(streamKey)===identity:this.seen.has(key))return;
    const orderId=data.orderId??data.entryOrderId??data.context?.orderId;
    const correlationId=data.intentId??data.entryIntentId??data.context?.entryIntentId??data.context?.signalCorrelationId??tradeId;
    const doc={...scope,event,eventType,eventKey:key,data,createdAt:now,updatedAt:now,
      ...(tradeId?{tradeId:String(tradeId)}:{}),...(orderId?{orderId:String(orderId)}:{}),...(correlationId?{correlationId:String(correlationId)}:{})};
    if(this.enqueue({filter:{portfolioId:scope.portfolioId,eventKey:key},update:{$setOnInsert:doc},
      ...(stateful?{transition:{streamKey,signature:identity}}:{})}))this.remember(this.seen,stateful?streamKey:key,stateful?identity:key);
  }
  private enqueue(write:RuntimeWrite,coalesce?:string){
    const bytes=Buffer.byteLength(JSON.stringify(write));
    const last=this.queue.at(-1);
    if(coalesce&&last?.coalesce===coalesce){this.bytes-=last.bytes;this.queue.pop();}
    if(bytes>512*1024||this.queue.length>=this.limit||this.bytes+bytes>8*1024*1024){this.diagnostics.dropped++;return false;}
    this.queue.push({write,bytes,coalesce});this.bytes+=bytes;
    if(!this.scheduled&&!this.active){this.scheduled=true;const timer=setTimeout(()=>{this.scheduled=false;void this.flush();},250);timer.unref?.();}
    return true;
  }
  async flush(){
    if(this.active)return;
    this.active=true;
    try{while(this.queue.length){const item=this.queue.shift()!;this.bytes-=item.bytes;
      try{await this.sink(item.write);this.diagnostics.written++;}catch{this.diagnostics.failed++;this.seen.clear();}
    }}finally{this.active=false;}
  }
}
export const runtimeRecorder=new RuntimeRecorder();
export function observeRuntime(observation:Observation){runtimeRecorder.observe(observation);}
