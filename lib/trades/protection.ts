import crypto from 'node:crypto';

export type ProtectionInspection={status:'ACTIVE'|'MISSING'|'AMBIGUOUS';missing:Array<'sl'|'tp'>;sl:number|null;tp:number|null};
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
