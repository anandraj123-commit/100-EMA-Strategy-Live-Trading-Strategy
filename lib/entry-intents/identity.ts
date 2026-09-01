import crypto from 'node:crypto';

export type EntrySetupIdentity={portfolioId:string;environment:'real'|'demo';productId:number;side:'buy'|'sell';signalCandleTime:number;configRevision:string};

export function entryIntentId(input:EntrySetupIdentity){
  return crypto.createHash('sha256').update([input.portfolioId,input.environment,input.productId,input.side,input.signalCandleTime,input.configRevision].join('|')).digest('hex');
}

export function entryClientOrderId(input:EntrySetupIdentity){return `ema-${entryIntentId(input).slice(0,28)}`;}
