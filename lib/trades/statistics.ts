import type { TradeDocument, TradeSource } from '../../models/Trade';

export interface TradeStats {
  totalTrades: number; winningTrades: number; losingTrades: number; winRate: number;
  grossPnL: number; brokerage: number; GST: number; otherCharges: number;
  totalCharges: number; netPnL: number; realizedR: number | null;
  fullyReconciledTrades: number;
  brokerageReportedTrades: number; gstReportedTrades: number;
  grossPnLReportedTrades:number; totalChargesReportedTrades:number;
  grossPnLComplete:boolean; brokerageComplete:boolean; gstComplete:boolean; totalChargesComplete:boolean; netPnLComplete:boolean;
  winRateBasis:'gross_actual';
}

export const emptyStats = (): TradeStats => ({ totalTrades:0, winningTrades:0, losingTrades:0, winRate:0, grossPnL:0, brokerage:0, GST:0, otherCharges:0, totalCharges:0, netPnL:0, realizedR:null, fullyReconciledTrades:0, brokerageReportedTrades:0, gstReportedTrades:0, grossPnLReportedTrades:0,totalChargesReportedTrades:0,grossPnLComplete:false,brokerageComplete:false,gstComplete:false,totalChargesComplete:false,netPnLComplete:false,winRateBasis:'gross_actual' });

export function calculateStats(trades: Pick<TradeDocument, 'source'|'status'|'grossPnL'|'brokerage'|'GST'|'otherCharges'|'totalCharges'|'netPnL'|'realizedR'|'financialStatus'>[], source?: TradeSource): TradeStats {
  const rows = trades.filter(t => t.status === 'CLOSED' && (!source || t.source === source));
  const out = emptyStats();
  let rCount = 0;
  for (const t of rows) {
    out.totalTrades++;
    if (t.grossPnL != null && t.grossPnL > 0) out.winningTrades++;
    else if (t.grossPnL != null && t.grossPnL < 0) out.losingTrades++;
    out.grossPnL += t.grossPnL ?? 0;
    out.brokerage += t.brokerage ?? 0;
    out.GST += t.GST ?? 0;
    out.otherCharges += t.otherCharges ?? 0;
    out.totalCharges += t.totalCharges ?? 0;
    out.netPnL += t.netPnL ?? 0;
    if (t.realizedR != null) { out.realizedR = (out.realizedR ?? 0) + t.realizedR; rCount++; }
    if (t.netPnL != null) out.fullyReconciledTrades++;
    if (t.brokerage != null) out.brokerageReportedTrades++;
    if (t.GST != null) out.gstReportedTrades++;
    if (t.grossPnL != null) out.grossPnLReportedTrades++;
    if (t.totalCharges != null) out.totalChargesReportedTrades++;
  }
  out.winRate = out.grossPnLReportedTrades ? out.winningTrades / out.grossPnLReportedTrades * 100 : 0;
  out.grossPnLComplete=out.totalTrades>0&&out.grossPnLReportedTrades===out.totalTrades;
  out.brokerageComplete=out.totalTrades>0&&out.brokerageReportedTrades===out.totalTrades;
  out.gstComplete=out.totalTrades>0&&out.gstReportedTrades===out.totalTrades;
  out.totalChargesComplete=out.totalTrades>0&&out.totalChargesReportedTrades===out.totalTrades;
  out.netPnLComplete=out.totalTrades>0&&out.fullyReconciledTrades===out.totalTrades;
  if (!rCount) out.realizedR = null;
  return out;
}
