import type { ObjectId } from 'mongodb';
export type RuntimeEventType = 'DECISION'|'TRADE'|'SYNC'|'PROTECTION'|'ROBOT'|'ERROR';
export interface RuntimeEventDocument {
  _id?:ObjectId;
  portfolioId:string;
  symbol?:string;
  eventType:RuntimeEventType;
  event:string;
  eventKey?:string;
  streamKey?:string;
  correlationId?:string;
  tradeId?:string;
  orderId?:string;
  resolution?:string;
  candleStartTime?:Date;
  current?:Record<string,any>;
  settingsSnapshot?:Record<string,any>;
  history?:{at:Date;state:Record<string,any>}[];
  stateSignature?:string;
  data?:Record<string,any>;
  createdAt:Date;
  updatedAt:Date;
}
