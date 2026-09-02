export type PortfolioDeletionState={positionKnown:boolean;positionSize:number|string|null};

export function isPortfolioDeleteDisabled(deletion:PortfolioDeletionState|undefined,deletionInProgress:boolean){
  if(deletionInProgress||deletion?.positionKnown!==true)return true;
  const positionSize=Number(deletion.positionSize);
  return !Number.isFinite(positionSize)||positionSize!==0;
}
