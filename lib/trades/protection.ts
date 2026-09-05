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

// Delta Order response contract: https://docs.delta.exchange/#order
// The schema marks response fields optional. Absence is UNVERIFIABLE, not INVALID.
// Bracket summary prices do not establish the child order's side, size or execution type.
export type TriggerMethod = 'mark_price' | 'last_traded_price' | 'spot_price';
export type ProtectionExpectation = {
  productId: number; direction: 'long' | 'short'; contracts: number;
  sl: number | null; tp: number | null; triggerMethod: TriggerMethod;
};
export type StrictProtectionInspection = {
  status: 'VALID' | 'INVALID' | 'UNVERIFIABLE' | 'MISSING';
  missing: Array<'sl' | 'tp'>; issues: string[];
  sl: number | null; tp: number | null; slOrderId: string | null; tpOrderId: string | null;
};
export const protectionNumber = (value: unknown): number | null =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) ? num(value) : null;
export function protectionTriggerMethod(source: string): TriggerMethod {
  return source === 'mark' ? 'mark_price' : source === 'spot' ? 'spot_price' : 'last_traded_price';
}
export function protectionTriggerPrice(ticker: any, method: TriggerMethod): number | null {
  // No fallback to a different source: these prices determine exchange stop triggers.
  const price = protectionNumber(ticker?.[method === 'last_traded_price' ? 'close' : method]);
  return price != null && price > 0 ? price : null;
}
export function protectionTriggerBreached(direction: 'long' | 'short', leg: 'sl' | 'tp', trigger: number, price: number) {
  return (direction === 'long') === (leg === 'sl') ? price <= trigger : price >= trigger;
}

export function inspectProtectionForSync(orders: any[], expected: ProtectionExpectation): StrictProtectionInspection {
  const result: StrictProtectionInspection = {status:'VALID', missing:[], issues:[], sl:null, tp:null, slOrderId:null, tpOrderId:null};
  let invalid = false, unverifiable = false;
  const issue = (reason: string, absent = false) => {
    result.issues.push(reason);
    if (absent) unverifiable = true; else invalid = true;
  };
  if (!Array.isArray(orders) || orders.some(order => !order || typeof order !== 'object' || Array.isArray(order) || protectionNumber(order.product_id) == null)) {
    return {...result, status:'UNVERIFIABLE', issues:['ORDER_SNAPSHOT_UNVERIFIABLE']};
  }
  const rows = orders.filter(order => protectionNumber(order.product_id) === expected.productId);
  // A truncated row is not evidence that this product has no protective orders.
  if (rows.some(order => order.stop_order_type === undefined)) {
    return {...result, status:'UNVERIFIABLE', issues:['ORDER_KIND_UNVERIFIABLE']};
  }
  const side = expected.direction === 'long' ? 'sell' : 'buy';
  for (const leg of ['sl','tp'] as const) {
    const kind = leg === 'sl' ? 'stop_loss_order' : 'take_profit_order';
    const candidates = rows.filter(order => order.stop_order_type === kind);
    const summaries = rows.some(order => order[leg === 'sl' ? 'bracket_stop_loss_price' : 'bracket_take_profit_price'] != null);
    // A stop whose kind is absent/unknown must not be mistaken for a missing leg.
    const unknownStops = rows.some(order => order.stop_price != null && !['stop_loss_order','take_profit_order'].includes(order.stop_order_type));
    if (!candidates.length) {
      if (summaries || unknownStops) issue(`${leg}:CHILD_ORDER_UNVERIFIABLE`, true);
      else if (expected[leg] != null) result.missing.push(leg);
      continue;
    }
    if (candidates.length !== 1) { issue(`${leg}:MULTIPLE_ORDERS`); continue; }
    const order = candidates[0];
    const check = (field: string, valid: boolean) => {
      if (order[field] == null) issue(`${leg}:${field}:UNVERIFIABLE`, true);
      else if (!valid) issue(`${leg}:${field}:INVALID`);
    };
    check('side', order.side === side);
    check('order_type', order.order_type === 'market_order');
    // Delta documents both a string schema and boolean response examples.
    check('reduce_only', order.reduce_only === true || order.reduce_only === 'true');
    check('stop_trigger_method', order.stop_trigger_method === expected.triggerMethod);
    check('size', protectionNumber(order.size) === expected.contracts && expected.contracts > 0);
    // Optional unfilled_size is additional evidence, not a replacement for order size.
    if (order.unfilled_size != null && protectionNumber(order.unfilled_size) !== expected.contracts) issue(`${leg}:unfilled_size:INVALID`);
    check('state', order.state === 'open' || order.state === 'pending');
    check('id', (typeof order.id === 'number' && Number.isFinite(order.id)) || (typeof order.id === 'string' && order.id.length > 0));
    const price = protectionNumber(order.stop_price);
    check('stop_price', price != null && price > 0);
    if (order.trail_amount != null && protectionNumber(order.trail_amount) !== 0) issue(`${leg}:TRAILING_ORDER_UNSUPPORTED`);
    result[leg] = price;
    result[leg === 'sl' ? 'slOrderId' : 'tpOrderId'] = order.id == null ? null : String(order.id);
  }
  result.status = invalid ? 'INVALID' : unverifiable ? 'UNVERIFIABLE' : result.missing.length ? 'MISSING' : 'VALID';
  return result;
}

// Price differences may only be adopted after a fresh trigger-source price check.
// Post-repair verification disallows adoption and demands the exact intended levels.
export function planProtectionSync(inspection: StrictProtectionInspection, expected: ProtectionExpectation, currentPrice: number | null, allowAdoption = true) {
  const updates: {sl?: number; tp?: number} = {}, issues = [...inspection.issues];
  if (inspection.status === 'INVALID' || inspection.status === 'UNVERIFIABLE') return {updates, repair:[], issues};
  for (const leg of ['sl','tp'] as const) {
    const price = inspection[leg], intended = expected[leg];
    if (price != null && (intended == null || !same(price, intended))) {
      if (!allowAdoption) issues.push(`${leg}:TRIGGER_PRICE_MISMATCH`);
      else if (currentPrice == null || currentPrice <= 0 || !Number.isFinite(currentPrice)) issues.push(`${leg}:TRIGGER_PRICE_UNVERIFIABLE`);
      else if (protectionTriggerBreached(expected.direction, leg, price, currentPrice)) issues.push(`${leg}:UNSAFE_PRICE_CHANGE`);
      else updates[leg] = price;
    }
  }
  const sl = updates.sl ?? expected.sl, tp = updates.tp ?? expected.tp;
  if (sl != null && tp != null && (expected.direction === 'long' ? sl >= tp : sl <= tp)) issues.push('INVALID_TRIGGER_RELATIONSHIP');
  return {updates:issues.length ? {} : updates, repair:issues.length ? [] : inspection.missing, issues};
}
