import { deltaErrorDetails } from '../delta';
import {
  inspectProtectionForSync, planProtectionSync, protectionNumber, protectionTriggerBreached,
  protectiveClientOrderId, type ProtectionExpectation, type StrictProtectionInspection, type TriggerMethod,
} from './protection';

export type ProtectionTrade = {
  tradeId?: string; source?: string; attributionStatus?: string; mixedPosition?: boolean;
  direction?: string; ownedContracts?: unknown; contracts?: unknown; sl?: unknown; tp?: unknown;
  entryIntentId?: string; clientOrderId?: string; protectionState?: string; exchangeSync?: any;
};
export type ProtectionStage = 'POSITION_LOOKUP' | 'ORDER_LOOKUP' | 'TRIGGER_PRICE_LOOKUP' | 'PERSISTENCE' |
  'PRE_REPAIR_POSITION_CHECK' | 'REPAIR_SUBMISSION' | 'POST_REPAIR_VERIFICATION';
export type ProtectionDependencies = {
  trade: () => ProtectionTrade | null;
  position: () => Promise<any>;
  orders: () => Promise<any[]>;
  triggerPrice: () => Promise<number | null>;
  ownership: () => Promise<boolean>;
  persist: (tradeId: string, values: {sl?: number; tp?: number; slOrderId?: string | null; tpOrderId?: string | null; state?: 'ACTIVE' | 'REPAIR_REQUIRED'}) => Promise<unknown>;
  bracket: (sl: number, tp: number) => Promise<unknown>;
  stop: (side: 'buy' | 'sell', size: number, leg: 'sl' | 'tp', price: number, clientOrderId: string) => Promise<unknown>;
  event: (type: string, details: Record<string, unknown>) => void;
  // Keep unconfirmed submissions across polling attempts. Never loop-submit after
  // a timeout or an apparently successful submission whose order is not visible yet.
  repairAttempts: Set<string>;
  now: () => number;
};

const confirmed = (trade: ProtectionTrade) => !trade.mixedPosition &&
  ((trade.source === 'bot' && trade.attributionStatus === 'BOT_CONFIRMED') ||
   (trade.source === 'exchange_existing' && trade.attributionStatus === 'MANUAL_CONFIRMED'));

export function protectionPositionMatches(position: any, expected: ProtectionExpectation) {
  const size = protectionNumber(position?.size);
  return protectionNumber(position?.product_id) === expected.productId && size != null && size !== 0 &&
    (expected.direction === 'long' ? size > 0 : size < 0) &&
    expected.contracts > 0 && Math.abs(size) === expected.contracts;
}

// Only protection reconciliation is extracted here; entry and ownership resolution stay in worker.ts.
export async function reconcileProtection(productId: number, triggerMethod: TriggerMethod, deps: ProtectionDependencies) {
  const trade = deps.trade();
  if (!trade?.tradeId || !confirmed(trade)) return;
  const tradeId = trade.tradeId;
  const expected: ProtectionExpectation = {
    productId, direction: trade.direction === 'long' ? 'long' : 'short',
    contracts: protectionNumber(trade.ownedContracts ?? trade.contracts) ?? 0,
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
    trade.direction === expected.direction && protectionNumber(trade.ownedContracts ?? trade.contracts) === expected.contracts &&
    protectionNumber(trade.sl) === expected.sl && protectionNumber(trade.tp) === expected.tp;
  const publishSync = (inspection: StrictProtectionInspection) => {
    trade.exchangeSync = {at:new Date(deps.now()).toISOString(), sl:inspection.sl, tp:inspection.tp, status:inspection.status};
  };
  const key = (leg: 'sl' | 'tp') => `${tradeId}:${leg}`;
  const activate = async (inspection: StrictProtectionInspection) => {
    stage = 'PERSISTENCE';
    await deps.persist(tradeId, {state:'ACTIVE', slOrderId:inspection.slOrderId, tpOrderId:inspection.tpOrderId});
    trade.protectionState = 'ACTIVE';
    publishSync(inspection);
    for (const leg of ['sl','tp'] as const) if (inspection[leg] != null) deps.repairAttempts.delete(key(leg));
  };
  try {
    stage = 'PERSISTENCE';
    if (!await deps.ownership()) return;
    stage = 'POSITION_LOOKUP';
    if (!['long','short'].includes(trade.direction ?? '') || !protectionPositionMatches(await deps.position(), expected)) {
      await markRequired(); event('PROTECTION_REPAIR_ABORTED', 'POSITION_OR_OWNED_QUANTITY_CHANGED'); return;
    }
    stage = 'ORDER_LOOKUP';
    const inspection = inspectProtectionForSync(await deps.orders(), expected);
    if (inspection.status === 'INVALID' || inspection.status === 'UNVERIFIABLE') {
      await markRequired(); publishSync(inspection);
      stage = 'ORDER_LOOKUP'; event('PROTECTION_VERIFICATION_FAILED', inspection.issues.join('; ')); return;
    }
    const needsPrice = (['sl','tp'] as const).some(leg => inspection[leg] != null && inspection[leg] !== expected[leg]);
    stage = 'TRIGGER_PRICE_LOOKUP';
    const submissionPending = (['sl','tp'] as const).some(leg => deps.repairAttempts.has(key(leg)));
    const plan = planProtectionSync(inspection, expected, needsPrice && !submissionPending ? await deps.triggerPrice() : null, !submissionPending);
    if (plan.issues.length) {
      await markRequired(); stage = 'ORDER_LOOKUP'; event('PROTECTION_VERIFICATION_FAILED', plan.issues.join('; ')); return;
    }
    if (Object.keys(plan.updates).length) {
      stage = 'PERSISTENCE';
      await deps.persist(tradeId, {...plan.updates, slOrderId:inspection.slOrderId, tpOrderId:inspection.tpOrderId});
      for (const leg of ['sl','tp'] as const) if (plan.updates[leg] !== undefined) {
        deps.event(leg === 'sl' ? 'SL_SYNCED_FROM_EXCHANGE' : 'TP_SYNCED_FROM_EXCHANGE', {tradeId, oldValue:expected[leg], newValue:plan.updates[leg]});
        trade[leg] = expected[leg] = plan.updates[leg]!;
      }
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
    const price = await deps.triggerPrice();
    if (price == null || !Number.isFinite(price) || price <= 0) {
      event('PROTECTION_REPAIR_ABORTED', 'TRIGGER_PRICE_UNVERIFIABLE'); return;
    }
    const breached = plan.repair.filter(leg => protectionTriggerBreached(expected.direction, leg, expected[leg]!, price));
    if (breached.length) {
      event('PROTECTION_REPAIR_BLOCKED_TRIGGER_BREACHED', 'INTENDED_TRIGGER_ALREADY_BREACHED', {missing:breached}); return;
    }
    stage = 'PRE_REPAIR_POSITION_CHECK';
    if (!await deps.ownership() || !protectionPositionMatches(await deps.position(), expected) || !currentOwnership()) {
      event('PROTECTION_REPAIR_ABORTED', 'POSITION_OR_OWNERSHIP_CHANGED'); return;
    }
    stage = 'REPAIR_SUBMISSION';
    event('PROTECTION_REPAIR_ATTEMPT', 'MISSING_VERIFIED_LEGS', {missing:plan.repair});
    // Mark before awaiting: a failed response does not prove Delta rejected the order.
    for (const leg of plan.repair) deps.repairAttempts.add(key(leg));
    if (plan.repair.length === 2) await deps.bracket(expected.sl!, expected.tp!);
    else {
      const leg = plan.repair[0];
      await deps.stop(expected.direction === 'long' ? 'sell' : 'buy', expected.contracts, leg, expected[leg]!,
        protectiveClientOrderId(trade.entryIntentId ?? trade.clientOrderId ?? tradeId, leg));
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
