// Compatibility entry points: portfolios are permanent. No database, exchange,
// control-file or lease operations are permitted by a deletion attempt.
export async function verifyPortfolioDeletion(_portfolio:unknown,_dependencies:unknown={}){return {ok:false as const,reason:'PORTFOLIO_DELETION_NOT_ALLOWED'};}
export async function deletePortfolioCoordinated(_portfolio:unknown,_remove:(id:string)=>Promise<boolean>,_dependencies:unknown={}){return {ok:false as const,reason:'PORTFOLIO_DELETION_NOT_ALLOWED'};}
