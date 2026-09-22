import type { TradeDocument } from '../../models/Trade';
import { deltaTimestampMilliseconds } from './reconciliation';
import { deltaErrorDetails } from '../delta';
import {
  supportedTriggerMethod, inspectProtectionForSync, planProtectionSync, protectionNumber, protectionTriggerBreached,
  protectiveClientOrderId, type ProtectionExpectation, type StrictProtectionInspection, type TriggerMethod,
} from './protection';

export type ProtectionTrade = {
  currentSLTriggerMethod?:TriggerMethod;currentTargetTriggerMethod?:TriggerMethod;
  tradeId?: string; source?: string; attributionStatus?: string; mixedPosition?: boolean;
  remainingContracts?:unknown; lifecycle?:TradeDocument; direction?: string; ownedContracts?: unknown; contracts?: unknown; sl?: unknown; tp?: unknown;
  entryIntentId?: string; clientOrderId?: string; protectionState?: string; exchangeSync?: any;
};
export type ProtectionStage = 'POSITION_LOOKUP' | 'ORDER_LOOKUP' | 'TRIGGER_PRICE_LOOKUP' | 'PERSISTENCE' |
  'PRE_REPAIR_POSITION_CHECK' | 'REPAIR_SUBMISSION' | 'POST_REPAIR_VERIFICATION';
export type ProtectionDependencies = {
  trade: () => ProtectionTrade | null;
  // Must use the explicitly product-scoped /v2/positions?product_id=productId request.
  position: () => Promise<any>;
  orders: () => Promise<any[]>;
  triggerPrice: (method?:TriggerMethod) => Promise<number | null>;
  ownership: () => Promise<boolean>;
  persist: (tradeId: string, values: {slTriggerMethod?:TriggerMethod;tpTriggerMethod?:TriggerMethod;slClientOrderId?:string|null;tpClientOrderId?:string|null;slModifiedAt?:Date;tpModifiedAt?:Date;sl?: number; tp?: number; slOrderId?: string | null; tpOrderId?: string | null; state?: 'ACTIVE' | 'REPAIR_REQUIRED'}) => Promise<unknown>;
  bracket: (sl: number, tp: number, method?:TriggerMethod) => Promise<unknown>;
  stop: (side: 'buy' | 'sell', size: number, leg: 'sl' | 'tp', price: number, clientOrderId: string, method?:TriggerMethod) => Promise<unknown>;
  event: (type: string, details: Record<string, unknown>) => void;
  // Keep unconfirmed submissions across polling attempts. Never loop-submit after
  // a timeout or an apparently successful submission whose order is not visible yet.
  repairAttempts: Set<string>;
  load?: () => Promise<TradeDocument|null>;
  verifyMissing?: (legs:('sl'|'tp')[]) => Promise<boolean>;
  claim?: (legs:('sl'|'tp')[],kind:'bracket'|'stop'|'resize') => Promise<Partial<Record<'sl'|'tp',{clientOrderId:string|null}>>|null>;
  resize?: (orderId:string,size:number) => Promise<unknown>;
  now: () => number;
};

const confirmed = (trade: ProtectionTrade) => !trade.mixedPosition &&
  ((trade.source === 'bot' && trade.attributionStatus === 'BOT_CONFIRMED') ||
   (trade.source === 'exchange_existing' && trade.attributionStatus === 'MANUAL_CONFIRMED'));

export function protectionPositionFailure(position: any, expected: ProtectionExpectation): string | null {
  if (!position || typeof position !== 'object' || Array.isArray(position)) return 'POSITION_MISSING_OR_INVALID';
  // The lightweight product-scoped response may omit product_id. Request scope
  // establishes identity only when absent; contradictory/malformed evidence fails.
  if ('product_id' in position && protectionNumber(position.product_id) !== expected.productId) return 'POSITION_PRODUCT_MISMATCH';
  const size = protectionNumber(position.size);
  if (size == null || size === 0) return 'POSITION_MISSING_OR_INVALID';
  if (!['long','short'].includes(expected.direction) || (expected.direction === 'long' ? size < 0 : size > 0)) return 'POSITION_DIRECTION_CHANGED';
  if (!Number.isFinite(expected.contracts) || expected.contracts <= 0) return 'OWNED_QUANTITY_CHANGED';
  // Both quantities are Delta contracts, not underlying quantity or notional.
  if (Math.abs(size) !== expected.contracts) return 'POSITION_QUANTITY_CHANGED';
  return null;
}

export function protectionPositionMatches(position: any, expected: ProtectionExpectation) {
  return protectionPositionFailure(position, expected) === null;
}

// Only protection reconciliation is extracted here; entry and ownership resolution stay in worker.ts.
export async function reconcileProtection(productId: number, triggerMethod: TriggerMethod, deps: ProtectionDependencies) {
  const trade = deps.trade();
  if (!trade?.tradeId || !confirmed(trade)) return;
  const tradeId = trade.tradeId;
  if(deps.load){
    try{
      const record=await deps.load();
      if(!record||record.status==='CLOSED'||record.productId!==productId||!['BOT_CONFIRMED','MANUAL_CONFIRMED'].includes(record.attributionStatus))return;
      trade.lifecycle=record;trade.sl=record.currentSL??record.initialSL;trade.tp=record.currentTarget??record.takeProfit;
      trade.currentSLTriggerMethod=record.currentSLTriggerMethod;trade.currentTargetTriggerMethod=record.currentTargetTriggerMethod;
      trade.remainingContracts=record.remainingContracts??trade.remainingContracts;
      for(const leg of ['sl','tp'] as const)if(record.protectionSubmissions?.[leg]?.state==='PENDING')deps.repairAttempts.add(`${tradeId}:${leg}`);
    }catch{deps.event('PROTECTION_RECONCILIATION_FAILED',{tradeId,reason:'DURABLE_PROTECTION_UNAVAILABLE'});return;}
  }
  if([trade.currentSLTriggerMethod,trade.currentTargetTriggerMethod].some(method=>method!=null&&!supportedTriggerMethod(method))){deps.event('PROTECTION_VERIFICATION_FAILED',{tradeId,reason:'PERSISTED_TRIGGER_METHOD_INVALID'});return;}
  const expected: ProtectionExpectation = {
    symbol:trade.lifecycle?.symbol,slTriggerMethod:trade.currentSLTriggerMethod??triggerMethod,tpTriggerMethod:trade.currentTargetTriggerMethod??triggerMethod,
    productId, direction: trade.direction === 'long' ? 'long' : 'short',
    contracts: protectionNumber(trade.remainingContracts ?? trade.ownedContracts ?? trade.contracts) ?? 0,
    sl: protectionNumber(trade.sl), tp: protectionNumber(trade.tp), triggerMethod,
  };
  let stage: ProtectionStage = 'POSITION_LOOKUP';
  const event = (type: string, reason: string, extra: Record<string, unknown> = {}) =>
    deps.event(type, {tradeId, stage, reason, ...extra});
  const markRequired = async () => {
    trade.protectionState = 'REPAIR_REQUIRED';
    trade.exchangeSync = {...trade.exchangeSync, status:'UNVERIFIABLE', attemptedAt:new Date(deps.now()).toISOString()};
    stage = 'PERSISTENCE';
    await deps.persist(tradeId, {state:'REPAIR_REQUIRED'});
  };
  const currentOwnership = () => deps.trade() === trade && confirmed(trade) && trade.tradeId === tradeId &&
    trade.direction === expected.direction && protectionNumber(trade.remainingContracts ?? trade.ownedContracts ?? trade.contracts) === expected.contracts &&
    protectionNumber(trade.sl) === expected.sl && protectionNumber(trade.tp) === expected.tp;
  const publishSync = (inspection: StrictProtectionInspection) => {
    trade.exchangeSync = {at:new Date(deps.now()).toISOString(), sl:inspection.sl, tp:inspection.tp, slTriggerMethod:inspection.slTriggerMethod,tpTriggerMethod:inspection.tpTriggerMethod,status:inspection.status};
  };
  const key = (leg: 'sl' | 'tp') => `${tradeId}:${leg}`;
  const methodsAndClients=(inspection:StrictProtectionInspection)=>({slTriggerMethod:inspection.slTriggerMethod,tpTriggerMethod:inspection.tpTriggerMethod,slClientOrderId:inspection.slClientOrderId,tpClientOrderId:inspection.tpClientOrderId});
  const activate = async (inspection: StrictProtectionInspection) => {
    stage = 'PERSISTENCE';
    await deps.persist(tradeId, {...methodsAndClients(inspection),state:'ACTIVE', slOrderId:inspection.slOrderId, tpOrderId:inspection.tpOrderId});
    trade.currentSLTriggerMethod=inspection.slTriggerMethod??trade.currentSLTriggerMethod;trade.currentTargetTriggerMethod=inspection.tpTriggerMethod??trade.currentTargetTriggerMethod;
    trade.protectionState = 'ACTIVE';
    publishSync(inspection);
    for (const leg of ['sl','tp'] as const) if (inspection[leg] != null) deps.repairAttempts.delete(key(leg));
  };
  try {
    stage = 'PERSISTENCE';
    if (!await deps.ownership()) return;
    stage = 'POSITION_LOOKUP';
    const positionFailure = !['long','short'].includes(trade.direction ?? '')
      ? 'POSITION_DIRECTION_CHANGED' : protectionPositionFailure(await deps.position(), expected);
    if (positionFailure) {
      await markRequired();
      stage = 'POSITION_LOOKUP';
      event('PROTECTION_REPAIR_ABORTED', positionFailure); return;
    }
    stage = 'ORDER_LOOKUP';
    const orderRows=await deps.orders();
    let inspection = inspectProtectionForSync(orderRows, expected,true);
    let resizeLegs:('sl'|'tp')[]|undefined;
    // A proven partial reduction may leave existing reduce-only orders oversized.
    // Edit those exact IDs; never cancel/recreate or accept malformed protection.
    if(deps.resize&&deps.claim&&inspection.status==='INVALID'&&expected.contracts<Number(trade.contracts)&&
      inspection.issues.length&&inspection.issues.every(issue=>/^((sl)|(tp)):(size|unfilled_size):INVALID$/.test(issue))){
      const legs=(['sl','tp'] as const).filter(leg=>inspection.issues.some(issue=>issue.startsWith(leg+':')));
      if(legs.some(leg=>inspection[leg+'OrderId' as 'slOrderId'|'tpOrderId']!==trade.lifecycle?.[leg==='sl'?'protectionSlOrderId':'protectionTpOrderId']))return;
      // Resize only untouched oversized orders; a partially filled/triggered order must reconcile first.
      if(legs.some(leg=>{const row=orderRows.find(o=>String(o.id)===inspection[leg==='sl'?'slOrderId':'tpOrderId']);return !row||Number(row.size)<=expected.contracts||(row.unfilled_size!=null&&Number(row.unfilled_size)!==Number(row.size));}))return;
      if(!currentOwnership()||!await deps.ownership()||!protectionPositionMatches(await deps.position(),expected))return;
      resizeLegs=legs;
      inspection={...inspection,status:'VALID',issues:[]};
    }
    if (inspection.status === 'INVALID' || inspection.status === 'UNVERIFIABLE') {
      await markRequired(); publishSync(inspection);
      stage = 'ORDER_LOOKUP'; event('PROTECTION_VERIFICATION_FAILED', inspection.issues.join('; ')); return;
    }
    for(const leg of ['sl','tp'] as const){
      const submission=trade.lifecycle?.protectionSubmissions?.[leg];
      if(submission?.state==='PENDING'&&inspection[leg]!=null&&
        ((submission.kind==='stop'&&submission.clientOrderId!==inspection[leg==='sl'?'slClientOrderId':'tpClientOrderId'])||
         (submission.kind==='resize'&&submission.orderId!==inspection[leg==='sl'?'slOrderId':'tpOrderId']))){
        event('PROTECTION_REPAIR_PENDING','PREVIOUS_SUBMISSION_NOT_YET_VERIFIED');return;
      }
    }
    if(inspection.missing.length&&deps.verifyMissing&&!await deps.verifyMissing(inspection.missing)){event('PROTECTION_REPAIR_PENDING','ORDER_STATUS_OR_FILL_NOT_YET_RECONCILED');return;}
    stage = 'TRIGGER_PRICE_LOOKUP';
    const submissionPending = (['sl','tp'] as const).some(leg => deps.repairAttempts.has(key(leg)));
    const prices:Partial<Record<'sl'|'tp',number|null>>={};
    if(!submissionPending)for(const leg of ['sl','tp'] as const){
      const methodKey=leg==='sl'?'slTriggerMethod':'tpTriggerMethod';
      if(inspection[leg]!=null&&(inspection[leg]!==expected[leg]||inspection[methodKey]!==expected[methodKey]))prices[leg]=await deps.triggerPrice(inspection[methodKey]);
    }
    const plan = planProtectionSync(inspection, expected, prices, !submissionPending);
    if (plan.issues.length) {
      await markRequired(); stage = 'ORDER_LOOKUP'; event('PROTECTION_VERIFICATION_FAILED', plan.issues.join('; ')); return;
    }
    if (Object.keys(plan.updates).length) {
      stage = 'PERSISTENCE';
      const modified: {slModifiedAt?:Date;tpModifiedAt?:Date}={};
      for(const leg of ['sl','tp'] as const){const row=orderRows.find(order=>String(order.id)===inspection[leg==='sl'?'slOrderId':'tpOrderId']);const ms=deltaTimestampMilliseconds(row?.updated_at);if(ms!=null)modified[leg==='sl'?'slModifiedAt':'tpModifiedAt']=new Date(ms);}
      await deps.persist(tradeId, {...methodsAndClients(inspection),...plan.updates,...modified, slOrderId:inspection.slOrderId, tpOrderId:inspection.tpOrderId});
      for(const leg of ['sl','tp'] as const){const key=leg==='sl'?'slTriggerMethod':'tpTriggerMethod';if(inspection[key]){expected[key]=inspection[key];trade[leg==='sl'?'currentSLTriggerMethod':'currentTargetTriggerMethod']=inspection[key];}}
      for (const leg of ['sl','tp'] as const) if (plan.updates[leg] !== undefined) {
        deps.event(leg === 'sl' ? 'SL_SYNCED_FROM_EXCHANGE' : 'TP_SYNCED_FROM_EXCHANGE', {tradeId, oldValue:expected[leg], newValue:plan.updates[leg]});
        trade[leg] = expected[leg] = plan.updates[leg]!;
      }
    }
    if(resizeLegs){
      // Adopt any validated price/method changes before resizing; pending verification
      // must compare against this newly established operational state.
      if(!currentOwnership()||!await deps.ownership()||!protectionPositionMatches(await deps.position(),expected))return;
      const claimed=await deps.claim!(resizeLegs,'resize');if(!claimed){event('PROTECTION_REPAIR_PENDING','PREVIOUS_SUBMISSION_NOT_YET_VERIFIED');return;}
      for(const leg of resizeLegs){deps.repairAttempts.add(key(leg));await deps.resize!(inspection[leg==='sl'?'slOrderId':'tpOrderId']!,expected.contracts);}
      event('PROTECTION_QUANTITY_RECONCILED','REMAINING_POSITION_QUANTITY',{contracts:expected.contracts});return;
    }
    // BOT protection requires both intended legs. Manual protection remains limited
    // to durable/adopted legs; do not invent a manual SL or TP.
    if ((trade.source === 'bot' && (expected.sl == null || expected.tp == null)) || (expected.sl == null && expected.tp == null)) {
      await markRequired(); event('PROTECTION_VERIFICATION_FAILED', 'INTENDED_PROTECTION_UNVERIFIABLE'); return;
    }
    if ([expected.sl, expected.tp].some(value => value != null && value <= 0)) {
      await markRequired(); event('PROTECTION_VERIFICATION_FAILED', 'INVALID_INTENDED_TRIGGER'); return;
    }
    if (!plan.repair.length) { await activate(inspection); return; }
    await markRequired();
    if (plan.repair.some(leg => deps.repairAttempts.has(key(leg)))) {
      event('PROTECTION_REPAIR_PENDING', 'PREVIOUS_SUBMISSION_NOT_YET_VERIFIED', {missing:plan.repair}); return;
    }
    // Re-read orders before repair; a changed snapshot is reconsidered next cycle.
    stage = 'ORDER_LOOKUP';
    const freshOrders = inspectProtectionForSync(await deps.orders(), expected);
    const freshPlan = planProtectionSync(freshOrders, expected, null, false);
    if (freshPlan.issues.length || freshPlan.repair.join(',') !== plan.repair.join(',')) {
      event('PROTECTION_REPAIR_ABORTED', 'ORDER_SNAPSHOT_CHANGED_OR_UNVERIFIABLE'); return;
    }
    stage = 'TRIGGER_PRICE_LOOKUP';
    const breached:('sl'|'tp')[]=[];
    for(const leg of plan.repair){
      const price=await deps.triggerPrice(expected[leg==='sl'?'slTriggerMethod':'tpTriggerMethod']);
      if(price==null||!Number.isFinite(price)||price<=0){event('PROTECTION_REPAIR_ABORTED','TRIGGER_PRICE_UNVERIFIABLE');return;}
      if(protectionTriggerBreached(expected.direction,leg,expected[leg]!,price))breached.push(leg);
    }
    if (breached.length) {
      event('PROTECTION_REPAIR_BLOCKED_TRIGGER_BREACHED', 'INTENDED_TRIGGER_ALREADY_BREACHED', {missing:breached}); return;
    }
    stage = 'PRE_REPAIR_POSITION_CHECK';
    let repairPositionFailure = !await deps.ownership() ? 'POSITION_OR_OWNERSHIP_CHANGED'
      : protectionPositionFailure(await deps.position(), expected);
    if (!repairPositionFailure && !currentOwnership()) {
      repairPositionFailure = protectionNumber(trade.remainingContracts ?? trade.ownedContracts ?? trade.contracts) !== expected.contracts
        ? 'OWNED_QUANTITY_CHANGED' : 'POSITION_OR_OWNERSHIP_CHANGED';
    }
    if (repairPositionFailure) {
      event('PROTECTION_REPAIR_ABORTED', repairPositionFailure); return;
    }
    // Delta's bracket API has one trigger method. Differing methods require separate legs.
    // Submit one leg per reconciliation so every submission gets fresh position/order evidence.
    const repairLegs=plan.repair.length===2&&expected.slTriggerMethod!==expected.tpTriggerMethod?plan.repair.slice(0,1):plan.repair;
    const claimed=deps.claim?await deps.claim(repairLegs,repairLegs.length===2?'bracket':'stop'):undefined;
    if(deps.claim&&!claimed){event('PROTECTION_REPAIR_PENDING','PREVIOUS_SUBMISSION_NOT_YET_VERIFIED');return;}
    stage = 'REPAIR_SUBMISSION';
    event('PROTECTION_REPAIR_ATTEMPT', 'MISSING_VERIFIED_LEGS', {missing:plan.repair});
    // Mark before awaiting: a failed response does not prove Delta rejected the order.
    for (const leg of repairLegs) deps.repairAttempts.add(key(leg));
    if (repairLegs.length === 2) await deps.bracket(expected.sl!, expected.tp!,expected.slTriggerMethod);
    else {
      const leg = repairLegs[0];
      await deps.stop(expected.direction === 'long' ? 'sell' : 'buy', expected.contracts, leg, expected[leg]!,
        claimed?.[leg]?.clientOrderId ?? protectiveClientOrderId(trade.entryIntentId ?? trade.clientOrderId ?? tradeId, leg),expected[leg==='sl'?'slTriggerMethod':'tpTriggerMethod']);
    }
    stage = 'POST_REPAIR_VERIFICATION';
    const verified = inspectProtectionForSync(await deps.orders(), expected);
    const verification = planProtectionSync(verified, expected, null, false);
    if (!protectionPositionMatches(await deps.position(), expected) || !currentOwnership() ||
        verified.status !== 'VALID' || verification.issues.length || verification.repair.length) {
      publishSync({...verified, status:verified.status === 'VALID' ? 'UNVERIFIABLE' : verified.status});
      event('PROTECTION_VERIFICATION_FAILED', verification.issues.join('; ') || 'POST_REPAIR_EVIDENCE_INCOMPLETE_OR_POSITION_CHANGED'); return;
    }
    await activate(verified);
    stage = 'POST_REPAIR_VERIFICATION';
    event('PROTECTION_REPAIRED', 'STRICT_VERIFICATION_PASSED', {sl:verified.sl, tp:verified.tp});
  } catch (error) {
    const failedStage = stage, detail = deltaErrorDetails(error);
    trade.protectionState = 'REPAIR_REQUIRED';
    trade.exchangeSync = {...trade.exchangeSync, status:'UNVERIFIABLE', attemptedAt:new Date(deps.now()).toISOString()};
    // A persistence outage must not hide the original stage or terminate monitoring.
    try { await deps.persist(tradeId, {state:'REPAIR_REQUIRED'}); } catch { /* retry next cycle */ }
    deps.event('PROTECTION_RECONCILIATION_FAILED', {tradeId, stage:failedStage, code:detail.code, message:detail.message,
      reason:`${failedStage}: ${detail.code}`, error:detail.message, retry:'NEXT_RECONCILIATION'});
  }
}


// Missing open orders alone are not cancellation evidence. Closed/filled orders
// must first be reflected in the owned lifecycle's reconciled exit-fill identities.
export function missingProtectionEvidence(record:TradeDocument,legs:('sl'|'tp')[],orders:any[],fills:any[],complete:boolean){
  const terminal:('sl'|'tp')[]=[];
  if(!complete||record.status==='CLOSED'||!(Number(record.remainingContracts)>0))return {allowed:false,terminal};
  for(const leg of legs){
    const submission=record.protectionSubmissions?.[leg],orderId=record[leg==='sl'?'protectionSlOrderId':'protectionTpOrderId'];
    const pending=submission?.state==='PENDING';
    if(!orderId&&!pending)continue;
    const row=orders.find(order=>Number(order.product_id)===record.productId&&
      (pending?(submission!.kind==='resize'?String(order.id)===submission!.orderId:submission!.clientOrderId?String(order.client_order_id)===submission!.clientOrderId:submission!.orderId!=null&&String(order.id)===submission!.orderId):String(order.id)===orderId));
    if(!row||!['cancelled','rejected','closed'].includes(row.state))return {allowed:false,terminal:[]};
    const executions=fills.filter(fill=>Number(fill.product_id)===record.productId&&String(fill.order_id)===String(row.id));
    if(row.state==='closed'&&!executions.length)return {allowed:false,terminal:[]};
    if(executions.some(fill=>!record.exitFillIds.includes(String(fill.id))))return {allowed:false,terminal:[]};
    if(pending)terminal.push(leg);
  }
  return {allowed:true,terminal};
}
