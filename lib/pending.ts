export type PendingSetup={direction:'long'|'short';trigger:number;sl:number;candleTime:number;validCandles?:number;expiresAfterCandleTime?:number};

// Candle identities are completed-candle opening timestamps, as in the worker.
// T0 creates the setup; T1 through TN are eligible; T(N+1) is expired.
export function pendingSetupExpired(pending:PendingSetup|null,latestCompletedCandleTime:number,entryValidCandles:number,resolutionSec:number){
  return pending!==null&&latestCompletedCandleTime>=pending.candleTime+(entryValidCandles+1)*resolutionSec;
}

export function pendingEntryEligible(pending:PendingSetup|null,latestCompletedCandleTime:number,entryValidCandles:number,resolutionSec:number){
  return pending!==null&&Number.isFinite(latestCompletedCandleTime)&&
    latestCompletedCandleTime>=pending.candleTime+resolutionSec&&
    !pendingSetupExpired(pending,latestCompletedCandleTime,entryValidCandles,resolutionSec);
}
