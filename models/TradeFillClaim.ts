export type TradeFillRole='ENTRY'|'EXIT';
export interface TradeFillClaimDocument {
  environment:'real'|'demo';
  productId:number;
  fillId:string;
  tradeId:string;
  portfolioId:string;
  role:TradeFillRole;
  createdAt:Date;
}
