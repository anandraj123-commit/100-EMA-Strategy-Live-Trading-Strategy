import type { AppMode } from '../app-mode';
import { calculateCurrentPnL } from '../dashboard';
import { validateStatusMode } from '../runtime/status-mode';

// Display freshness only; does not control the worker or its polling interval.
export const PORTFOLIO_STATUS_MAX_AGE_MS = 120_000;
export type PortfolioCardRuntime = { running:boolean|null; trade:'OPEN'|'FLAT'|'UNAVAILABLE'; pnl:number|null; expiresAt:number };
export function portfolioCardRuntime(snapshot:unknown, mode:AppMode, portfolioId:string, now=Date.now()):PortfolioCardRuntime {
  const status=validateStatusMode(snapshot,mode);
  const timestamp=typeof status.updatedAt==='string'?Date.parse(status.updatedAt):NaN;
  const unavailable:PortfolioCardRuntime={running:null,trade:'UNAVAILABLE',pnl:null,expiresAt:0};
  if(status.statusAvailable===false||status.portfolioId!==portfolioId||
    (status.connection as any)?.state!=='online'||!Number.isFinite(timestamp)||timestamp>now||now-timestamp>PORTFOLIO_STATUS_MAX_AGE_MS)return unavailable;
  const position=status.position as any;
  const rawSize=position?.size;
  const size=rawSize==null||rawSize===''?NaN:Number(rawSize);
  const trade=!Number.isFinite(size)?'UNAVAILABLE':size===0?'FLAT':'OPEN';
  const pnl=trade==='OPEN'&&status.price!=null
    ? calculateCurrentPnL({positionSize:size,entryPrice:position?.entryPrice,currentPrice:status.price,contractValue:status.contractValue}).value:null;
  return {running:typeof status.running==='boolean'?status.running:null,trade,pnl,expiresAt:timestamp+PORTFOLIO_STATUS_MAX_AGE_MS};
}
