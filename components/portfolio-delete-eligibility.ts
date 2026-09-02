export type PortfolioDeletionState={allowed:boolean;positionKnown:boolean;positionSize:number|string|null;reason?:string|null};

export function isPortfolioDeleteDisabled(deletion:PortfolioDeletionState|undefined,deletionInProgress:boolean){
  return deletionInProgress||deletion?.allowed!==true;
}
