export function calculateCurrentPnL(input:{positionSize:unknown;entryPrice:unknown;currentPrice:unknown;contractValue?:unknown}){
  const size=Number(input.positionSize),entry=Number(input.entryPrice),current=Number(input.currentPrice),contractValue=input.contractValue==null?1:Number(input.contractValue);
  if(!Number.isFinite(size)||size===0||!Number.isFinite(entry)||entry<=0||!Number.isFinite(current)||!Number.isFinite(contractValue)||contractValue<=0)return {value:null,percentage:null};
  const quantity=Math.abs(size)*contractValue;
  const value=(size>0?current-entry:entry-current)*quantity;
  const notional=entry*quantity;
  return {value,percentage:notional>0?value/notional*100:null};
}

export function paginateItems<T>(items:T[],page:number,limit:number){
  const safeLimit=Math.max(1,Math.min(100,Math.trunc(limit)||1)),total=items.length,totalPages=Math.max(1,Math.ceil(total/safeLimit)),safePage=Math.max(1,Math.min(totalPages,Math.trunc(page)||1));
  return {items:items.slice((safePage-1)*safeLimit,safePage*safeLimit),pagination:{page:safePage,limit:safeLimit,total,totalPages,hasNext:safePage<totalPages,hasPrevious:safePage>1}};
}
