import crypto from 'node:crypto';
import type { AttributionStatus, FinancialStatus, TradeSide } from '../../models/Trade';

export interface DeltaFill { id?: string|number; order_id?: string|number; client_order_id?: string; product_id?: number; product_symbol?: string; side?: string; price?: string|number; size?: string|number; commission?: string|number; created_at?: string|number; }
export interface DeltaOrder { id?:string|number; client_order_id?:string; product_id?:number; side?:string; reduce_only?:boolean; stop_order_type?:string; created_at?:string|number; }

const id=(value:unknown)=>value==null?null:String(value);
export function deltaTimestampMilliseconds(value:unknown):number|null {
  if(value==null||value==='') return null;
  const text=String(value).trim();
  if(!text) return null;
  if(/^\d+$/.test(text)) {
    const numeric=Number(text);
    if(!Number.isSafeInteger(numeric)) return null;
    if(numeric>=1_000_000_000_000_000) return Math.trunc(numeric/1_000);
    if(numeric>=1_000_000_000_000) return numeric;
    return null;
  }
  const parsed=Date.parse(text);
  return Number.isFinite(parsed)?parsed:null;
}
const time=deltaTimestampMilliseconds;
const signedSize=(fill:DeltaFill)=>Math.abs(Number(fill.size||0))*(String(fill.side).toLowerCase()==='buy'?1:-1);
const nearly=(a:number,b:number)=>Math.abs(a-b)<1e-9;

export type OwnershipResolution = {status:AttributionStatus;reason:string;botOwnedContracts:number;mixedPosition:boolean;staleBotClosed:boolean};
export function resolvePositionOwnership(input:{lookupFailed:boolean;currentSize:number;productId:number;persisted?:{entryOrderId:string|null;entryClientOrderId:string|null;entryTime:Date|null;side:TradeSide;contracts:number|null}|null;fills:DeltaFill[];orders:DeltaOrder[];historyComplete:boolean}):OwnershipResolution {
  const unknown=(status:AttributionStatus,reason:string,staleBotClosed=false):OwnershipResolution=>({status,reason,botOwnedContracts:0,mixedPosition:false,staleBotClosed});
  if(input.lookupFailed) return unknown('LOOKUP_FAILED','MongoDB ownership lookup failed');
  const fills=input.fills.filter(f=>Number(f.product_id)===input.productId&&time(f.created_at)!=null).sort((a,b)=>(time(a.created_at)??0)-(time(b.created_at)??0));
  const orderById=new Map(input.orders.filter(o=>Number(o.product_id)===input.productId).map(o=>[id(o.id),o]));
  if(input.persisted) {
    const entryId=input.persisted.entryOrderId;
    if(!entryId) return unknown('UNKNOWN','Persisted bot record has no entry order ID');
    const order=orderById.get(entryId);
    if(!order||id(order.client_order_id)!==input.persisted.entryClientOrderId||!String(order.client_order_id||'').startsWith('ema-')) return unknown('UNKNOWN','Persisted entry order is not confirmed by Delta');
    const entryIndexes=fills.map((f,index)=>id(f.order_id)===entryId?index:-1).filter(index=>index>=0);
    if(!entryIndexes.length) return unknown('UNKNOWN','Persisted entry fills are absent from bounded Delta history');
    const start=entryIndexes[0]; let balance=0, closedBeforeEnd=false, mixed=false;
    for(let index=start;index<fills.length;index++) {
      const fill=fills[index]; balance+=signedSize(fill);
      if(id(fill.order_id)!==entryId&&String(fill.side).toLowerCase()===(input.persisted.side==='LONG'?'buy':'sell')) mixed=true;
      if(nearly(balance,0)&&index<fills.length-1) closedBeforeEnd=true;
    }
    if(closedBeforeEnd) return unknown('UNKNOWN','Persisted bot lifecycle reached zero before later same-symbol activity',true);
    if(!input.historyComplete) return unknown('UNKNOWN','Delta history pagination was incomplete');
    if(!nearly(balance,input.currentSize)) return unknown('UNKNOWN','Exchange fill lifecycle does not match current position');
    const expectedSign=input.persisted.side==='LONG'?1:-1;
    if(Math.sign(input.currentSize)!==expectedSign) return unknown('UNKNOWN','Current position side differs from persisted bot entry');
    return {status:'BOT_CONFIRMED',reason:'Delta entry order and uninterrupted fill lifecycle confirmed',botOwnedContracts:Math.min(Math.abs(input.currentSize),Math.abs(input.persisted.contracts??0)),mixedPosition:mixed||Math.abs(input.currentSize)>Math.abs(input.persisted.contracts??0),staleBotClosed:false};
  }
  if(!input.historyComplete||!fills.length) return unknown('UNKNOWN','Complete current-position lifecycle is unavailable');
  let balance=input.currentSize; let boundary=fills.length;
  for(let index=fills.length-1;index>=0;index--){const previous=balance-signedSize(fills[index]);if(nearly(previous,0)){boundary=index;break;}balance=previous;}
  if(boundary===fills.length) return unknown('UNKNOWN','No reliable zero-to-open lifecycle boundary found');
  const lifecycle=fills.slice(boundary); const openingSide=input.currentSize>0?'buy':'sell';
  const openingFills=lifecycle.filter(f=>String(f.side).toLowerCase()===openingSide);
  const openingOrders=openingFills.map(f=>orderById.get(id(f.order_id)));
  const mappedOpeningOrders=openingOrders.filter((order):order is DeltaOrder=>!!order);
  if(!openingFills.length||mappedOpeningOrders.length<openingFills.length) return unknown('UNKNOWN','Every opening fill must map to a known order');
  if(mappedOpeningOrders.some(o=>typeof o.client_order_id!=='string'||!o.client_order_id||o.client_order_id.startsWith('ema-'))) return unknown('UNKNOWN','Lifecycle contains bot-generated or unverified opening orders');
  return {status:'MANUAL_CONFIRMED',reason:'Complete non-bot Delta lifecycle confirmed',botOwnedContracts:0,mixedPosition:false,staleBotClosed:false};
}

export type FillAttribution={entryFills:DeltaFill[];exitFills:DeltaFill[];complete:boolean;ambiguous:boolean;reason:string};
export type BotExitOutcome='WIN'|'LOSS'|'BREAKEVEN'|'UNKNOWN';
export type BotExitClassification={outcome:BotExitOutcome;exitReason:'SL'|'TP'|'MANUAL_CLOSE'|'UNKNOWN';actualEntryPrice:number|null;actualExitPrice:number|null;reason:string};

export function classifyBotExitEvidence(input:{side:TradeSide;productId:number;ownedContracts:number;entryOrderId:string;fills:DeltaFill[];orders:DeltaOrder[];windowStart:number;windowEnd:number;historyComplete:boolean;mixedPosition:boolean}):BotExitClassification {
  const unknown=(reason:string):BotExitClassification=>({outcome:'UNKNOWN',exitReason:'UNKNOWN',actualEntryPrice:null,actualExitPrice:null,reason});
  if(!input.historyComplete) return unknown('Delta exit history is incomplete');
  if(input.mixedPosition) return unknown('Same-symbol bot/manual quantity was mixed');
  const fills=input.fills.filter(f=>Number(f.product_id)===input.productId&&time(f.created_at)!=null&&(time(f.created_at) as number)>=input.windowStart&&(time(f.created_at) as number)<=input.windowEnd).sort((a,b)=>(time(a.created_at)??0)-(time(b.created_at)??0));
  const entryFills=fills.filter(f=>id(f.order_id)===input.entryOrderId);
  const entrySize=entryFills.reduce((total,fill)=>total+Math.abs(Number(fill.size||0)),0);
  if(!entryFills.length||!nearly(entrySize,input.ownedContracts)) return unknown('Exact bot entry fills are unavailable');
  const entryBoundary=Math.max(...entryFills.map(f=>time(f.created_at)??0));
  const exitSide=input.side==='LONG'?'sell':'buy';
  const lifecycle=fills.filter(f=>(time(f.created_at)??0)>=entryBoundary);
  if(lifecycle.some(f=>id(f.order_id)!==input.entryOrderId&&String(f.side).toLowerCase()!==exitSide)) return unknown('Bot lifecycle contains an unattributed same-side addition');
  const exitFills=lifecycle.filter(f=>id(f.order_id)!==input.entryOrderId&&String(f.side).toLowerCase()===exitSide);
  let exitSize=0;
  for(const fill of exitFills){const size=Math.abs(Number(fill.size||0));if(size<=0||exitSize+size>input.ownedContracts)return unknown('Exit fill crosses bot-owned quantity');exitSize+=size;}
  if(!exitFills.length||!nearly(exitSize,input.ownedContracts)) return unknown('Exact bot exit quantity is unavailable');
  const orderById=new Map(input.orders.filter(o=>Number(o.product_id)===input.productId).map(o=>[id(o.id),o]));
  const exitOrders=exitFills.map(fill=>orderById.get(id(fill.order_id)));
  if(exitOrders.some(order=>!order)) return unknown('Exit order evidence is unavailable');
  const reasons=new Set(exitOrders.map(order=>order?.stop_order_type==='take_profit_order'?'TP':order?.stop_order_type==='stop_loss_order'?'SL':'MANUAL_CLOSE'));
  if(reasons.size!==1) return unknown('Exit fills have mixed exit reasons');
  const actualEntryPrice=weightedAverage(entryFills), actualExitPrice=weightedAverage(exitFills);
  const exitReason=[...reasons][0] as 'SL'|'TP'|'MANUAL_CLOSE';
  if(exitReason==='TP') return {outcome:'WIN',exitReason,actualEntryPrice,actualExitPrice,reason:'Delta take-profit order and fills confirmed'};
  if(exitReason==='SL') return {outcome:'LOSS',exitReason,actualEntryPrice,actualExitPrice,reason:'Delta stop-loss order and fills confirmed'};
  if(actualEntryPrice==null||actualExitPrice==null) return unknown('Manual close prices are unavailable');
  const gross=grossPnL(input.side,actualEntryPrice,actualExitPrice,1);
  return {outcome:gross!>0?'WIN':gross!<0?'LOSS':'BREAKEVEN',exitReason:'MANUAL_CLOSE',actualEntryPrice,actualExitPrice,reason:'Exact manual-close fills determine realized gross outcome'};
}

export function applyDailyLossOutcome(currentStreak:number,outcome:BotExitOutcome){return outcome==='WIN'?0:outcome==='LOSS'?currentStreak+1:currentStreak;}

export function findBotCloseBoundary(input:{productId:number;entryOrderId:string;fills:DeltaFill[]}) {
  const fills=input.fills.filter(f=>Number(f.product_id)===input.productId&&time(f.created_at)!=null).sort((a,b)=>(time(a.created_at)??0)-(time(b.created_at)??0));
  const start=fills.findIndex(f=>id(f.order_id)===input.entryOrderId); if(start<0) return null;
  let balance=0;
  for(let index=start;index<fills.length;index++){balance+=signedSize(fills[index]);if(index>start&&nearly(balance,0))return time(fills[index].created_at);}
  return null;
}

export function findTradeCloseBoundary(input:{productId:number;entryFillIds:string[];fills:DeltaFill[]}) {
  const entryIds=new Set(input.entryFillIds);
  const fills=input.fills.filter(f=>Number(f.product_id)===input.productId&&time(f.created_at)!=null).sort((a,b)=>(time(a.created_at)??0)-(time(b.created_at)??0));
  const start=fills.findIndex(f=>entryIds.has(id(f.id)??'')); if(start<0) return null;
  let balance=0; const seen=new Set<string>();
  for(let index=start;index<fills.length;index++){
    const fill=fills[index],fillIdentity=id(fill.id);if(fillIdentity&&entryIds.has(fillIdentity))seen.add(fillIdentity);
    balance+=signedSize(fill);
    if(seen.size===entryIds.size&&nearly(balance,0))return time(fill.created_at);
  }
  return null;
}

export function attributeTradeFills(input:{source:'bot'|'exchange_existing';side:TradeSide;productId:number;ownedContracts:number;entryOrderId:string|null;entryFillIds?:string[];fills:DeltaFill[];orders:DeltaOrder[];windowStart:number;windowEnd:number;historyComplete:boolean;mixedPosition:boolean}):FillAttribution {
  const relevant=input.fills.filter(f=>Number(f.product_id)===input.productId&&time(f.created_at)!=null&&(time(f.created_at) as number)>=input.windowStart&&(time(f.created_at) as number)<=input.windowEnd).sort((a,b)=>(time(a.created_at)??0)-(time(b.created_at)??0));
  const orderById=new Map(input.orders.filter(o=>Number(o.product_id)===input.productId).map(o=>[id(o.id),o]));
  const knownEntryIds=new Set(input.entryFillIds??[]);
  const entryFills=input.source==='bot'&&input.entryOrderId?relevant.filter(f=>id(f.order_id)===input.entryOrderId):input.source==='exchange_existing'?relevant.filter(f=>knownEntryIds.has(id(f.id)??'')):[];
  const exitSide=input.side==='LONG'?'sell':'buy';
  const entryBoundary=entryFills.length?Math.max(...entryFills.map(f=>time(f.created_at)??0)):input.windowStart;
  const lifecycleFills=relevant.filter(f=>(time(f.created_at)??0)>=entryBoundary);
  const candidates=lifecycleFills.filter(f=>String(f.side).toLowerCase()===exitSide&&id(f.order_id)!==input.entryOrderId);
  if(!input.historyComplete) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Delta history pagination incomplete'};
  if(input.mixedPosition) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Same-symbol manual/bot quantity was mixed'};
  if(input.source==='bot'&&(!entryFills.length||!nearly(entryFills.reduce((n,f)=>n+Math.abs(Number(f.size||0)),0),input.ownedContracts))) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Bot entry fill coverage is incomplete'};
  if(input.source==='exchange_existing'&&(!knownEntryIds.size||entryFills.length!==knownEntryIds.size||!nearly(entryFills.reduce((n,f)=>n+Math.abs(Number(f.size||0)),0),input.ownedContracts))) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Manual entry fill coverage is incomplete'};
  if(input.source==='bot'&&lifecycleFills.some(f=>id(f.order_id)!==input.entryOrderId&&String(f.side).toLowerCase()!==(input.side==='LONG'?'sell':'buy'))) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Bot lifecycle contains an unattributed same-side addition'};
  if(input.source==='exchange_existing'&&lifecycleFills.some(f=>!knownEntryIds.has(id(f.id)??'')&&String(f.side).toLowerCase()!==exitSide)) return {entryFills:[],exitFills:[],complete:false,ambiguous:true,reason:'Manual close window contains additions or reversal activity'};
  let total=0; const exitFills:DeltaFill[]=[];
  for(const fill of candidates){const size=Math.abs(Number(fill.size||0));if(size<=0||total+size>input.ownedContracts) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Exit fill crosses the reliably owned quantity boundary'};const order=orderById.get(id(fill.order_id));if(!order) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Exit order evidence is unavailable'};if(input.source==='bot'&&order.reduce_only!==true&&!order.stop_order_type) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Bot exit order is not proven reduce-only or protective'};exitFills.push(fill);total+=size;}
  if(!exitFills.length||!nearly(total,input.ownedContracts)) return {entryFills,exitFills:[],complete:false,ambiguous:true,reason:'Exact exit quantity is not attributable'};
  return {entryFills,exitFills,complete:true,ambiguous:false,reason:'Exact lifecycle quantity and order evidence confirmed'};
}

const finite = (value: unknown): number|null => { const n = Number(value); return value !== null && value !== '' && Number.isFinite(n) ? n : null; };
export function weightedAverage(fills: DeltaFill[]): number|null {
  let value = 0, size = 0;
  for (const fill of fills) { const p=finite(fill.price), q=finite(fill.size); if (p == null || q == null || q <= 0) continue; value += p*q; size += q; }
  return size ? value/size : null;
}
export function aggregateCommission(fills: DeltaFill[]): number|null {
  if (!fills.length) return null;
  let total=0;
  for (const fill of fills) { const fee=finite(fill.commission); if (fee == null) return null; total += fee; }
  return total;
}
export function grossPnL(side: TradeSide, entry:number|null, exit:number|null, quantity:number|null): number|null {
  if (entry == null || exit == null || quantity == null) return null;
  return (side === 'LONG' ? exit-entry : entry-exit) * quantity;
}
export function stableTradeId(source:string, productId:number, entryOrderId:string|null, entryFillIds:string[], exitFillIds:string[]): string|null {
  const identity = source==='bot'&&entryOrderId ? `entry-order:${entryOrderId}` : exitFillIds.length ? `exit:${[...exitFillIds].sort().join(',')}` : entryOrderId ? `entry-order:${entryOrderId}` : entryFillIds.length ? `entry:${[...entryFillIds].sort().join(',')}` : null;
  if (!identity) return null;
  return `${source}:${productId}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0,32)}`;
}
export function financials(input:{side:TradeSide; entry:number|null; exit:number|null; quantity:number|null; entryFills:DeltaFill[]; exitFills:DeltaFill[]; estimatedBrokerage?:number|null; estimatedGST?:number|null}) {
  const gross = grossPnL(input.side,input.entry,input.exit,input.quantity);
  const brokerage = input.entryFills.length && input.exitFills.length ? aggregateCommission([...input.entryFills,...input.exitFills]) : null;
  const GST = null; // Delta fills document commission, but no attributable GST field.
  const otherCharges = null;
  const totalCharges = brokerage != null && GST != null && otherCharges != null ? brokerage+GST+otherCharges : null;
  const netPnL = gross != null && totalCharges != null ? gross-totalCharges : null;
  const hasPrices = input.entry != null && input.exit != null && input.quantity != null;
  const financialStatus:FinancialStatus = hasPrices && totalCharges != null ? 'actual' : hasPrices ? 'partial' : (input.estimatedBrokerage != null || input.estimatedGST != null) ? 'estimated' : 'unavailable';
  const estimatedTotalCharges = input.estimatedBrokerage != null && input.estimatedGST != null ? input.estimatedBrokerage+input.estimatedGST : null;
  return {grossPnL:gross,brokerage,GST,otherCharges,totalCharges,netPnL,estimatedBrokerage:input.estimatedBrokerage??null,estimatedGST:input.estimatedGST??null,estimatedTotalCharges,estimatedNetPnL:gross != null && estimatedTotalCharges != null ? gross-estimatedTotalCharges:null,financialStatus};
}
