export type PendingSetup={direction:'long'|'short';trigger:number;sl:number;candleTime:number;validCandles?:number;expiresAfterCandleTime?:number};

export function pendingSetupExpired(pending:PendingSetup|null,latestCompletedCandleTime:number,entryValidCandles:number,resolutionSec:number){
  return pending!==null&&latestCompletedCandleTime>=pending.candleTime+entryValidCandles*resolutionSec;
}
