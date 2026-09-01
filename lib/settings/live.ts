import type { RuntimeSettingValue } from '../../models/RuntimeSettings';

export const strategyStateKeys=new Set(['RESOLUTION','EMA_LENGTH','SLOPE_LOOKBACK','ENTRY_VALID_CANDLES']);
export const pendingInvalidatingKeys=new Set(['RESOLUTION','EMA_LENGTH','SLOPE_LOOKBACK','ENTRY_VALID_CANDLES','RR','RISK_PCT','RISK_BASE','MAX_DAILY_CONSECUTIVE_LOSSES','MIN_STOP_PCT','MAX_EFFECTIVE_LEVERAGE','MAX_FEE_RISK_PCT','GST_PCT','ORDER_LEVERAGE','PRICE_SOURCE']);

export function changedRuntimeSettings(previous:Record<string,RuntimeSettingValue>,next:Record<string,RuntimeSettingValue>){
  return Object.keys(next).filter(key=>previous[key]!==next[key]).sort();
}

export function runtimeSettingsRevision(values:Record<string,RuntimeSettingValue>){
  return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a],[b])=>a.localeCompare(b))));
}

export function liveAutoTradeValue(overrides:Record<string,RuntimeSettingValue>,current:boolean){
  if(!Object.prototype.hasOwnProperty.call(overrides,'AUTO_TRADE'))return current;
  if(typeof overrides.AUTO_TRADE!=='boolean')throw new Error('AUTO_TRADE must be boolean');
  return overrides.AUTO_TRADE;
}
