import { getModeConfig, getDeltaConfig } from './app-mode';
const modeConfig = getModeConfig();

export function resolutionToSeconds(resolution: string): number {
  const value = resolution.trim().toLowerCase();
  const match = value.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Unsupported RESOLUTION format: ${resolution}. Use values like 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid RESOLUTION: ${resolution}`);
  }

  const multiplier = unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return amount * multiplier;
}

const { apiKey, apiSecret } = modeConfig.delta;

const resolutionRaw = (process.env.RESOLUTION || '5m').trim();
const resolution = resolutionRaw.toLowerCase();
const resolutionSec = resolutionToSeconds(resolution);
const entryValidCandlesRaw = Number(process.env.ENTRY_VALID_CANDLES || 2);
if (!Number.isFinite(entryValidCandlesRaw) || entryValidCandlesRaw < 1) {
  throw new Error('ENTRY_VALID_CANDLES must be a number greater than or equal to 1.');
}
const entryValidCandles = Math.floor(entryValidCandlesRaw);
export function validateRiskBase(value:unknown):'available' {
  if(value!=='available')throw new Error('RISK_BASE must be available');
  return 'available';
}
const riskBase=validateRiskBase((process.env.RISK_BASE||'available').trim().toLowerCase());

export const config = {
  appMode: modeConfig.appMode,
  env: modeConfig.delta.env,
  apiKey,
  apiSecret,
  symbol: process.env.SYMBOL || 'XAUTUSD',
  resolution,
  resolutionSec,
  emaLen: Number(process.env.EMA_LENGTH || 100),
  slopeLookback: Number(process.env.SLOPE_LOOKBACK || 3),
  entryValidCandles,
  rr: Number(process.env.RR || 8),
  riskPct: Number(process.env.RISK_PCT || 1),
  maxDailyLosses: Number(process.env.MAX_DAILY_CONSECUTIVE_LOSSES || 10),
  minStopPct: Number(process.env.MIN_STOP_PCT || 0),
  maxEffectiveLeverage: Number(process.env.MAX_EFFECTIVE_LEVERAGE || 100),
  maxFeeRiskPct: Number(process.env.MAX_FEE_RISK_PCT || 20),
  gstPct: Number(process.env.GST_PCT || 18),
  orderLeverage: Number(process.env.ORDER_LEVERAGE || 100),
  autoTrade: (process.env.AUTO_TRADE || 'false').toLowerCase() === 'true',
  riskBase,
  // Delta chart's 'Traded Price' corresponds to the ticker last traded price.
  // Keep this environment-driven; default to last so live breakout matches that chart.
  priceSource: (process.env.PRICE_SOURCE || 'last') as 'mark'|'last'|'spot',
  pollMs: Number(process.env.POLL_MS || 1000),
  // Use a long, EMA-derived warm-up instead of a fixed 180-bar window.
  // This makes live EMA converge to the same value as a long-history chart/backtest.
  candleHistoryBars: Math.min(2000, Math.max(200, Number(process.env.EMA_LENGTH || 100) * 10 + Number(process.env.SLOPE_LOOKBACK || 3) + 10)),
};

export const baseUrl = modeConfig.delta.baseUrl;

export type RuntimeEnvironment='real'|'demo';
// Compatibility parameter only: a legacy portfolio cannot select an endpoint.
export function getDeltaEnvironment(_environment?:RuntimeEnvironment){return getDeltaConfig();}
export function configurePortfolioRuntime(_environment:RuntimeEnvironment,symbol:string){
  const resolved=getDeltaConfig();
  config.symbol=symbol;
  return {environment:resolved.environment,credentialsConfigured:true,baseUrl:resolved.baseUrl};
}

export function applyRuntimeConfigOverrides(values:Record<string,string|number|boolean>){
  if('RISK_BASE' in values)validateRiskBase(values.RISK_BASE);
  const mapping:Record<string,keyof typeof config>={RESOLUTION:'resolution',AUTO_TRADE:'autoTrade',POLL_MS:'pollMs',EMA_LENGTH:'emaLen',SLOPE_LOOKBACK:'slopeLookback',ENTRY_VALID_CANDLES:'entryValidCandles',RR:'rr',RISK_PCT:'riskPct',RISK_BASE:'riskBase',MAX_DAILY_CONSECUTIVE_LOSSES:'maxDailyLosses',MIN_STOP_PCT:'minStopPct',MAX_EFFECTIVE_LEVERAGE:'maxEffectiveLeverage',MAX_FEE_RISK_PCT:'maxFeeRiskPct',GST_PCT:'gstPct',ORDER_LEVERAGE:'orderLeverage',PRICE_SOURCE:'priceSource'};
  for(const [key,value] of Object.entries(values)){const property=mapping[key];if(property)(config as Record<string,unknown>)[property]=value;}
  config.resolutionSec=resolutionToSeconds(config.resolution);
  config.candleHistoryBars=Math.min(2000,Math.max(200,config.emaLen*10+config.slopeLookback+10));
}
