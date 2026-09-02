export type PortfolioDeleteRef={current:string};

export function claimPortfolioDeletion(ref:PortfolioDeleteRef,portfolioId:string){
  if(ref.current)return false;
  ref.current=portfolioId;
  return true;
}

export function releasePortfolioDeletion(ref:PortfolioDeleteRef){ref.current='';}

export function removeDeletedPortfolio<T extends {id:string}>(rows:T[],portfolioId:string){
  return rows.filter(row=>row.id!==portfolioId);
}

export async function requestPortfolioDeletion(portfolioId:string,csrf:string,request:typeof fetch=fetch){
  const response=await request('/api/portfolio',{method:'DELETE',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({id:portfolioId})});
  let data:any={};
  try{data=await response.json();}catch{}
  if(!response.ok)throw new Error(typeof data?.error==='string'&&data.error?data.error:'Unable to delete portfolio.');
}
