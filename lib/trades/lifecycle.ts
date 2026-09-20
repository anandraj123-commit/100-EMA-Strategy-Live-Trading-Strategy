import type { TradeDocument, ProtectionPriceChange } from '../../models/Trade';
import { deltaTimestampMilliseconds, weightedAverage, type DeltaFill } from './reconciliation';

export const finiteNumber=(v:unknown):number|null=>v===null||v===undefined||v===''||typeof v==='boolean'?null:Number.isFinite(Number(v))?Number(v):null;
export const samePrice=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-9);
export function entryExecutionMetrics(side:string,reference:unknown,average:unknown,contracts:unknown,contractValue:unknown){
  const ref=finiteNumber(reference),fill=finiteNumber(average),size=finiteNumber(contracts),cv=finiteNumber(contractValue);
  if(ref==null||ref<=0||fill==null||fill<=0)return {entrySlippagePct:null,entrySlippageAmount:null};
  // Positive = adverse execution for BOTH sides; amount is settling-currency impact.
  const adverse=side==='SHORT'?ref-fill:fill-ref;
  return {entrySlippagePct:adverse/ref*100,entrySlippageAmount:size!=null&&cv!=null?adverse*Math.abs(size)*cv:null};
}
export function exposureMetrics(position:any,contractValue:unknown,equityAtEntry:unknown){
  const size=finiteNumber(position?.size),cv=finiteNumber(contractValue),price=finiteNumber(position?.mark_price??position?.entry_price);
  const margin=finiteNumber(position?.margin),equity=finiteNumber(equityAtEntry);
  const notional=size!=null&&cv!=null&&cv>0&&price!=null&&price>0?Math.abs(size)*cv*price:null;
  return {remainingContracts:size==null?null:Math.abs(size),remainingQuantity:size!=null&&cv!=null?Math.abs(size)*cv:null,
    positionNotional:notional,marginUsed:margin!=null&&margin>=0?margin:null,
    effectiveLeverage:notional!=null&&margin!=null&&margin>0?notional/margin:null,
    marginUsedPct:margin!=null&&margin>=0&&equity!=null&&equity>0?margin/equity*100:null};
}
export function uniqueFills(fills:DeltaFill[]){
  const seen=new Map<string,DeltaFill>();
  for(const fill of fills){if(fill.id==null)throw new Error('Fill identity unavailable');const id=String(fill.id),previous=seen.get(id);
    if(previous&&['order_id','product_id','side','price','size'].some(key=>String((previous as any)[key])!==String((fill as any)[key])))throw new Error('Conflicting fill identity');
    seen.set(id,fill);
  }
  return [...seen.values()].sort((a,b)=>(deltaTimestampMilliseconds(a.created_at)??0)-(deltaTimestampMilliseconds(b.created_at)??0));
}

// OPEN reconciliation proves the same uninterrupted owned lifecycle, including reductions.
// It never claims unknown positions and never uses polling prices as execution prices.
export function openExecutionPatch(record:TradeDocument,position:any,fills:DeltaFill[],orders:any[],complete:boolean){
  if(!complete||!['BOT_CONFIRMED','MANUAL_CONFIRMED'].includes(record.attributionStatus)||record.status==='CLOSED')return null;
  const size=finiteNumber(position?.size);
  if(size==null||size===0||(size>0)!==(record.side==='LONG'))return null;
  if(position.product_id!=null&&Number(position.product_id)!==record.productId)return null;
  const all=uniqueFills(fills).filter(f=>Number(f.product_id)===record.productId&&deltaTimestampMilliseconds(f.created_at)!=null);
  const entryIds=new Set(record.entryFillIds),orderIds=new Set(record.entryOrderIds??(record.entryOrderId?[record.entryOrderId]:[]));
  const entries=all.filter(f=>record.source==='bot'?orderIds.has(String(f.order_id)):(entryIds.has(String(f.id))||orderIds.has(String(f.order_id))));
  if(!entries.length)return null;
  const entrySide=record.side==='LONG'?'buy':'sell';
  if(entries.some(f=>f.side!==entrySide||!(Number(f.size)>0)))return null;
  const known=new Set(entries.map(f=>String(f.id))),start=deltaTimestampMilliseconds(entries[0].created_at)!;
  const lifecycle=all.filter(f=>deltaTimestampMilliseconds(f.created_at)!>=start);
  let balance=0;const exits:DeltaFill[]=[];
  for(const fill of lifecycle){
    if(!['buy','sell'].includes(fill.side??'')||!(Number(fill.size)>0))return null;
    if(!known.has(String(fill.id))){if(fill.side===entrySide)return null;
      const order=orders.find(o=>String(o.id)===String(fill.order_id)&&Number(o.product_id)===record.productId);
      if(!order)return null;exits.push(fill);}
    balance+=Math.abs(Number(fill.size))*(fill.side==='buy'?1:-1);
    if(!Number.isFinite(balance)||balance===0||Math.sign(balance)!==Math.sign(size))return null;
  }
  if(!samePrice(balance,size))return null;
  const entryOrders=[...new Set(entries.map(f=>String(f.order_id)))].map(id=>orders.find(o=>String(o.id)===id&&Number(o.product_id)===record.productId));
  const finalized=entryOrders.every(o=>{
    if(!o||!['closed','cancelled'].includes(o.state))return false;
    const filled=finiteNumber(o.filled_size??(o.size!=null&&o.unfilled_size!=null?Number(o.size)-Number(o.unfilled_size):null));
    return filled==null||samePrice(filled,entries.filter(f=>String(f.order_id)===String(o.id)).reduce((sum,f)=>sum+Number(f.size),0));
  });
  const contracts=entries.reduce((n,f)=>n+Math.abs(Number(f.size)),0),actualEntryPrice=weightedAverage(entries);
  return {actualEntryPrice,entryTime:new Date(start),entryTimeSource:'exchange' as const,entryDataStatus:finalized?'reconciled' as const:'provisional' as const,
    contracts,quantity:record.contractValue!=null?contracts*record.contractValue:null,
    entryFillIds:entries.map(f=>String(f.id)),entryOrderIds:[...new Set(entries.map(f=>String(f.order_id)))],
    exitFillIds:exits.map(f=>String(f.id)),exitOrderIds:[...new Set(exits.map(f=>String(f.order_id)))],
    ...entryExecutionMetrics(record.side,record.intendedEntryPrice,actualEntryPrice,contracts,record.contractValue),
    ...exposureMetrics(position,record.contractValue,record.equityAtEntry)};
}

// Repository CAS serializes this patch with histories, fills, close and repair writes.
export function protectionPricePatch(record:TradeDocument,values:{sl?:number;tp?:number;slOrderId?:string|null;tpOrderId?:string|null;slModifiedAt?:Date;tpModifiedAt?:Date},now:Date){
  const patch:Partial<TradeDocument>={};
  for(const leg of ['sl','tp'] as const){
    const value=values[leg];if(value==null||!Number.isFinite(value)||value<=0)continue;
    const initial=leg==='sl'?'initialSL':'takeProfit',current=leg==='sl'?'currentSL':'currentTarget',history=leg==='sl'?'slHistory':'targetHistory';
    const previous=record[current]??record[initial];
    if(record[initial]==null)patch[initial]=value;
    if(previous==null||samePrice(previous,value)){patch[current]=previous??value;continue;}
    const exchangeTime=values[leg==='sl'?'slModifiedAt':'tpModifiedAt'];
    const event:ProtectionPriceChange={previousValue:previous,value,modifiedAt:exchangeTime??now,timeSource:exchangeTime?'exchange':'observed',source:'EXCHANGE_RECONCILIATION',orderId:values[leg==='sl'?'slOrderId':'tpOrderId']??null};
    patch[current]=value;patch[history]=[...(record[history]??[]),event];
  }
  return patch;
}

export function mergeTradeLifecycle(previous:TradeDocument,next:Partial<TradeDocument>):TradeDocument {
  if(['portfolioId','environment','productId','symbol','source'].some(key=>(next as any)[key]!=null&&(previous as any)[key]!== (next as any)[key]))throw new Error('Trade lifecycle identity mismatch');
  if(previous.status==='CLOSED'&&next.status!== 'CLOSED')return previous;
  const merged={...previous,...next};
  if(next.status==='OPEN'&&previous.reconciledAt)for(const key of ['remainingContracts','remainingQuantity','exitFillIds','exitOrderIds','reconciledAt'] as const)(merged as any)[key]=previous[key];
  // Initial protection, audit and entry snapshots are never overwritten by OPEN/CLOSE upserts.
  for(const key of ['initialSL','takeProfit','equityAtEntry','entryBid','entryAsk','entrySpreadAmount','entrySpreadPct','entrySpreadTime'] as const){if(previous[key]!=null)(merged as any)[key]=previous[key];}
  for(const key of ['currentSL','currentTarget','slHistory','targetHistory','currentSLTriggerMethod','currentTargetTriggerMethod','protectionSlClientOrderId','protectionTpClientOrderId','protectionSubmissions','protectionSlOrderId','protectionTpOrderId','protectionState','protectionUpdatedAt'] as const){if(previous[key]!=null)(merged as any)[key]=previous[key];}
  if(previous.entryDataStatus==='reconciled')for(const key of ['entryTime','entryTimeSource','actualEntryPrice','contracts','quantity','entryFillIds','entryOrderIds','entrySlippagePct','entrySlippageAmount','entryDataStatus'] as const)(merged as any)[key]=previous[key];
  // Repeated provisional snapshots cannot erase already-reconciled evidence.
  if(previous.entryTimeSource==='exchange'&&next.entryTimeSource!=='exchange'){merged.entryTime=previous.entryTime;merged.entryTimeSource=previous.entryTimeSource;}
  if(previous.exitTimeSource==='exchange')for(const key of ['exitTime','exitTimeSource','actualExitPrice','exitReason','exitFillIds','exitOrderIds','exitOrderId'] as const)(merged as any)[key]=previous[key];
  return merged;
}
