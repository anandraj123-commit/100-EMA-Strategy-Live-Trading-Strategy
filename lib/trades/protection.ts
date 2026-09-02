import crypto from 'node:crypto';

export type ProtectionInspection={status:'ACTIVE'|'MISSING'|'AMBIGUOUS';missing:Array<'sl'|'tp'>;sl:number|null;tp:number|null};
export type ProtectionSyncInspection={status:'KNOWN'|'AMBIGUOUS';sl:number|null;tp:number|null;slOrderId:string|null;tpOrderId:string|null};
export type ProtectionSyncPlan={updates:{sl?:number;tp?:number};repair:Array<'sl'|'tp'>;unchanged:boolean};
const num=(value:unknown)=>{const n=Number(value);return value!==null&&value!==undefined&&value!==''&&Number.isFinite(n)?n:null;};
const same=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-9);

export function inspectProtectionOrders(orders:any[],productId:number,intendedSl:number,intendedTp:number):ProtectionInspection{
  const slValues:number[]=[],tpValues:number[]=[];
  for(const order of orders.filter(order=>Number(order?.product_id)===productId)){
    const bracketSl=num(order?.bracket_stop_loss_price),bracketTp=num(order?.bracket_take_profit_price),stop=num(order?.stop_price);
    if(bracketSl!=null)slValues.push(bracketSl);if(bracketTp!=null)tpValues.push(bracketTp);
    if(stop!=null&&order?.stop_order_type==='stop_loss_order')slValues.push(stop);
    if(stop!=null&&order?.stop_order_type==='take_profit_order')tpValues.push(stop);
  }
  const unique=(values:number[])=>[...new Set(values.map(String))].map(Number),sls=unique(slValues),tps=unique(tpValues);
  if(sls.length>1||tps.length>1||(sls.length===1&&!same(sls[0],intendedSl))||(tps.length===1&&!same(tps[0],intendedTp)))return {status:'AMBIGUOUS',missing:[],sl:sls[0]??null,tp:tps[0]??null};
  const missing:Array<'sl'|'tp'>=[];if(!sls.length)missing.push('sl');if(!tps.length)missing.push('tp');
  return {status:missing.length?'MISSING':'ACTIVE',missing,sl:sls[0]??null,tp:tps[0]??null};
}

export function protectiveClientOrderId(entryIdentity:string,leg:'sl'|'tp'){return `pr-${leg}-${crypto.createHash('sha256').update(`${entryIdentity}|${leg}`).digest('hex').slice(0,24)}`;}

export function inspectProtectionForSync(orders:any[],productId:number,protectiveSide:'buy'|'sell'):ProtectionSyncInspection{
  const sl:Array<{price:number;id:string|null}>=[],tp:Array<{price:number;id:string|null}>=[];
  for(const order of orders.filter(order=>Number(order?.product_id)===productId)){
    const id=order?.id==null?null:String(order.id),side=typeof order?.side==='string'?order.side.toLowerCase():null;
    if(side&&side!==protectiveSide)continue;
    const bracketSl=num(order?.bracket_stop_loss_price),bracketTp=num(order?.bracket_take_profit_price),stop=num(order?.stop_price);
    if(bracketSl!=null)sl.push({price:bracketSl,id});if(bracketTp!=null)tp.push({price:bracketTp,id});
    if(stop!=null&&order?.reduce_only!==false&&order?.stop_order_type==='stop_loss_order')sl.push({price:stop,id});
    if(stop!=null&&order?.reduce_only!==false&&order?.stop_order_type==='take_profit_order')tp.push({price:stop,id});
  }
  if(sl.length>1||tp.length>1)return {status:'AMBIGUOUS',sl:null,tp:null,slOrderId:null,tpOrderId:null};
  return {status:'KNOWN',sl:sl[0]?.price??null,tp:tp[0]?.price??null,slOrderId:sl[0]?.id??null,tpOrderId:tp[0]?.id??null};
}

export function planProtectionSync(inspection:ProtectionSyncInspection,durableSl:unknown,durableTp:unknown):ProtectionSyncPlan{
  if(inspection.status==='AMBIGUOUS')return {updates:{},repair:[],unchanged:false};
  const sl=num(durableSl),tp=num(durableTp),updates:ProtectionSyncPlan['updates']={},repair:Array<'sl'|'tp'>=[];
  if(inspection.sl!=null){if(sl==null||!same(inspection.sl,sl))updates.sl=inspection.sl;}else if(sl!=null)repair.push('sl');
  if(inspection.tp!=null){if(tp==null||!same(inspection.tp,tp))updates.tp=inspection.tp;}else if(tp!=null)repair.push('tp');
  return {updates,repair,unchanged:Object.keys(updates).length===0&&repair.length===0};
}
