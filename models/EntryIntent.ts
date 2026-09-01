export type EntryIntentState='PREPARED'|'SUBMITTING'|'CONFIRMED'|'AMBIGUOUS'|'FAILED_CONFIRMED';

export interface EntryIntentDocument {
  intentId:string;
  portfolioId:string;
  environment:'real'|'demo';
  symbol:string;
  productId:number;
  side:'buy'|'sell';
  direction:'long'|'short';
  contracts:number;
  clientOrderId:string;
  signalCandleTime:number;
  configRevision:string;
  trigger:number;
  sl:number;
  tp:number;
  contractValue:number;
  riskAmount:number;
  takerRate:number;
  gstPct:number;
  strategyConfig:Record<string,string|number>;
  state:EntryIntentState;
  deltaOrderId:string|null;
  deltaFillIds:string[];
  actualEntryPrice:number|null;
  submissionStartedAt:Date|null;
  confirmedAt:Date|null;
  ambiguousAt:Date|null;
  lastReconciledAt:Date|null;
  ownershipPersistedAt:Date|null;
  createdAt:Date;
  updatedAt:Date;
}
