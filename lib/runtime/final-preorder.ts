import { pendingSetupExpired } from '../pending';

export type FinalPreOrderReason='FINAL_PREORDER_ROBOT_STOPPED'|'FINAL_PREORDER_AUTO_TRADE_OFF'|'FINAL_PREORDER_CONFIG_CHANGED'|'FINAL_PREORDER_PENDING_REPLACED'|'FINAL_PREORDER_PENDING_EXPIRED'|'FINAL_PREORDER_LEASE_LOST'|'FINAL_PREORDER_DELETION_IN_PROGRESS'|'FINAL_PREORDER_POSITION_NONZERO'|'FINAL_PREORDER_MARGIN_INVALID'|'FINAL_PREORDER_RISK_GUARD'|'FINAL_PREORDER_PORTFOLIO_MISMATCH';
export type FinalPending={direction:'long'|'short';trigger:number;sl:number;candleTime:number;configRevision:string};
export type FinalConfig={revision:string;autoTrade:boolean;entryValidCandles:number;resolutionSec:number;riskPct:number;rr:number;minStopPct:number;maxEffectiveLeverage:number;maxFeeRiskPct:number;gstPct:number};
export type FinalIdentity={portfolioId:string;environment:'real'|'demo';symbol:string;productId:number};
export type FinalProduct={id:number;contractValue:number;tickSize:number;takerRate:number};
export type FinalPreOrderInput={identity:FinalIdentity;setup:FinalPending;config:FinalConfig;product:FinalProduct;expectedContracts?:number};
export type FinalPreOrderDependencies={robotRunning:()=>boolean;refreshConfig:()=>Promise<FinalConfig>;currentPending:()=>FinalPending|null;latestCompletedCandleTime:()=>number;leaseOwned:()=>Promise<boolean>;leaseLost:()=>boolean;portfolioEntryAllowed:()=>Promise<boolean>;portfolio:()=>Promise<{id:string;environment:string;symbol:string;productId:number}|null>;position:()=>Promise<any>;availableMargin:()=>Promise<number>};

const sameSetup=(a:FinalPending|null,b:FinalPending)=>Boolean(a&&a.direction===b.direction&&a.trigger===b.trigger&&a.sl===b.sl&&a.candleTime===b.candleTime&&a.configRevision===b.configRevision);
const roundToTick=(price:number,tick:number)=>Math.round(price/tick)*tick;
const blocked=(reason:FinalPreOrderReason)=>({ok:false as const,reason});

export async function finalPreOrderSafetyCheck(input:FinalPreOrderInput,deps:FinalPreOrderDependencies){
  if(!deps.robotRunning())return blocked('FINAL_PREORDER_ROBOT_STOPPED');
  const currentConfig=await deps.refreshConfig();
  if(!currentConfig.autoTrade)return blocked('FINAL_PREORDER_AUTO_TRADE_OFF');
  if(currentConfig.revision!==input.config.revision)return blocked('FINAL_PREORDER_CONFIG_CHANGED');
  const currentPending=deps.currentPending();
  if(!sameSetup(currentPending,input.setup))return blocked('FINAL_PREORDER_PENDING_REPLACED');
  if(pendingSetupExpired(currentPending,deps.latestCompletedCandleTime(),currentConfig.entryValidCandles,currentConfig.resolutionSec))return blocked('FINAL_PREORDER_PENDING_EXPIRED');
  if(deps.leaseLost()||!await deps.leaseOwned())return blocked('FINAL_PREORDER_LEASE_LOST');
  if(!await deps.portfolioEntryAllowed())return blocked('FINAL_PREORDER_DELETION_IN_PROGRESS');
  const portfolio=await deps.portfolio();
  if(!portfolio||portfolio.id!==input.identity.portfolioId||portfolio.environment!==input.identity.environment||portfolio.symbol!==input.identity.symbol||portfolio.productId!==input.identity.productId||input.product.id!==input.identity.productId)return blocked('FINAL_PREORDER_PORTFOLIO_MISMATCH');
  if(Number((await deps.position())?.size||0)!==0)return blocked('FINAL_PREORDER_POSITION_NONZERO');
  const available=await deps.availableMargin();
  if(!Number.isFinite(available)||available<=0)return blocked('FINAL_PREORDER_MARGIN_INVALID');
  if(!Number.isFinite(input.product.contractValue)||input.product.contractValue<=0||!Number.isFinite(input.product.tickSize)||input.product.tickSize<=0)return {...blocked('FINAL_PREORDER_RISK_GUARD'),guard:'INVALID_PRODUCT_METADATA'};
  if(!Number.isFinite(input.setup.trigger)||input.setup.trigger<=0||!Number.isFinite(input.setup.sl)||input.setup.sl<=0)return {...blocked('FINAL_PREORDER_RISK_GUARD'),guard:'INVALID_ENTRY_PRICES'};
  const stopDistance=Math.abs(input.setup.trigger-input.setup.sl),stopPct=stopDistance/input.setup.trigger*100,riskAmount=available*currentConfig.riskPct/100;
  const contracts=Math.floor((stopDistance>0?riskAmount/stopDistance:0)/input.product.contractValue);
  const notional=contracts*input.product.contractValue*input.setup.trigger,effectiveLeverage=notional/available;
  const tp=roundToTick(input.setup.direction==='long'?input.setup.trigger+stopDistance*currentConfig.rr:input.setup.trigger-stopDistance*currentConfig.rr,input.product.tickSize);
  const sl=roundToTick(input.setup.sl,input.product.tickSize),exitNotional=contracts*input.product.contractValue*tp;
  const feeBeforeGST=(notional+exitNotional)*input.product.takerRate,estimatedFees=feeBeforeGST*(1+currentConfig.gstPct/100),feeRiskPct=riskAmount>0?estimatedFees/riskAmount*100:Infinity;
  let guard:string|null=null;
  if(![riskAmount,stopDistance,stopPct,contracts,notional,effectiveLeverage,tp,sl,exitNotional,feeBeforeGST,estimatedFees,feeRiskPct].every(Number.isFinite))guard='INVALID_CALCULATION';else if(contracts<1)guard='SIZE_BELOW_ONE_CONTRACT';else if(input.setup.direction==='long'&&!(sl<input.setup.trigger&&tp>input.setup.trigger))guard='INVALID_PROTECTION_DIRECTION';else if(input.setup.direction==='short'&&!(sl>input.setup.trigger&&tp<input.setup.trigger))guard='INVALID_PROTECTION_DIRECTION';else if(stopPct<currentConfig.minStopPct)guard='STOP_TOO_TIGHT';else if(effectiveLeverage>currentConfig.maxEffectiveLeverage)guard='LEVERAGE_TOO_HIGH';else if(feeRiskPct>currentConfig.maxFeeRiskPct)guard='FEES_TOO_HIGH';else if(input.expectedContracts!==undefined&&contracts!==input.expectedContracts)guard='FINAL_QUANTITY_CHANGED';
  if(guard)return {...blocked('FINAL_PREORDER_RISK_GUARD'),guard};
  return {ok:true as const,available,riskAmount,contracts,stopDistance,stopPct,notional,effectiveLeverage,tp,sl,feeBeforeGST,estimatedFees,feeRiskPct,takerRate:input.product.takerRate};
}
