import dotenv from 'dotenv';
import path from 'node:path';

// The standalone tsx worker does NOT get Next.js' automatic .env.local loading.
// Load it here before any config values are read.
const envPath = path.resolve(process.cwd(), '.env.local');
const envResult = dotenv.config({ path: envPath, override: false });

if (envResult.error) {
  console.warn(`[config] Could not load ${envPath}: ${envResult.error.message}`);
}


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

const apiKey = (process.env.DELTA_API_KEY || '').trim();
const apiSecret = (process.env.DELTA_API_SECRET || '').trim();

console.log('[config] cwd:', process.cwd());
console.log('[config] env file:', envPath);
console.log('[config] DELTA_ENV:', process.env.DELTA_ENV || 'demo');
console.log('[config] API KEY LOADED:', Boolean(apiKey));
console.log('[config] API SECRET LOADED:', Boolean(apiSecret));

const resolutionRaw = (process.env.RESOLUTION || '').trim();
if (!resolutionRaw) throw new Error('RESOLUTION is required in .env.local (for example 1m, 5m, 15m, 1h).');
const resolution = resolutionRaw.toLowerCase();
const resolutionSec = resolutionToSeconds(resolution);

const entryValidCandlesRaw = Number(process.env.ENTRY_VALID_CANDLES || 2);
if (!Number.isFinite(entryValidCandlesRaw) || entryValidCandlesRaw < 1) {
  throw new Error('ENTRY_VALID_CANDLES must be a number greater than or equal to 1.');
}
const entryValidCandles = Math.floor(entryValidCandlesRaw);

export const config = {
  env: (process.env.DELTA_ENV || 'demo') as 'demo' | 'live',
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
  riskBase: (process.env.RISK_BASE || 'available') as 'equity' | 'available',
  // Delta chart's 'Traded Price' corresponds to the ticker last traded price.
  // Keep this environment-driven; default to last so live breakout matches that chart.
  priceSource: (process.env.PRICE_SOURCE || 'last') as 'mark'|'last'|'spot',
  pollMs: Number(process.env.POLL_MS || 1000),
  // Use a long, EMA-derived warm-up instead of a fixed 180-bar window.
  // This makes live EMA converge to the same value as a long-history chart/backtest.
  candleHistoryBars: Math.min(2000, Math.max(200, Number(process.env.EMA_LENGTH || 100) * 10 + Number(process.env.SLOPE_LOOKBACK || 3) + 10)),
};

// Bot environment values shown read-only on the dashboard. Secrets are never exposed.
export const environmentVariables = {
  DELTA_ENV: config.env,
  DELTA_API_KEY: config.apiKey ? '[SET - HIDDEN]' : '[NOT SET]',
  DELTA_API_SECRET: config.apiSecret ? '[SET - HIDDEN]' : '[NOT SET]',
  SYMBOL: config.symbol,
  RESOLUTION: config.resolution,
  EMA_LENGTH: config.emaLen,
  SLOPE_LOOKBACK: config.slopeLookback,
  ENTRY_VALID_CANDLES: config.entryValidCandles,
  RR: config.rr,
  RISK_PCT: config.riskPct,
  RISK_BASE: config.riskBase,
  MAX_DAILY_CONSECUTIVE_LOSSES: config.maxDailyLosses,
  MIN_STOP_PCT: config.minStopPct,
  MAX_EFFECTIVE_LEVERAGE: config.maxEffectiveLeverage,
  MAX_FEE_RISK_PCT: config.maxFeeRiskPct,
  GST_PCT: config.gstPct,
  ORDER_LEVERAGE: config.orderLeverage,
  PRICE_SOURCE: config.priceSource,
  AUTO_TRADE: config.autoTrade,
  POLL_MS: config.pollMs
};

export const baseUrl = config.env === 'live'
  ? 'https://api.india.delta.exchange'
  : 'https://cdn-ind.testnet.deltaex.org';
