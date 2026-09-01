import { config, resolutionToSeconds } from '../config';
import type { RuntimeSettingValue } from '../../models/RuntimeSettings';

export type SettingDefinition = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  defaultValue: RuntimeSettingValue;
  restartRequired: boolean;
  validate(value: unknown): RuntimeSettingValue;
};

const numberSetting = (key:string,label:string,defaultValue:number,min:number,max:number,integer=false):SettingDefinition => ({
  key,label,type:'number',defaultValue,restartRequired:false,
  validate(value){
    if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value))) throw new Error(`${key} must be ${integer?'an integer':'a finite number'} between ${min} and ${max}`);
    return value;
  }
});
const choiceSetting=(key:string,label:string,defaultValue:string,choices:string[]):SettingDefinition=>({key,label,type:'string',defaultValue,restartRequired:false,validate(value){if(typeof value!=='string'||!choices.includes(value))throw new Error(`${key} must be one of: ${choices.join(', ')}`);return value;}});

export const runtimeSettingDefinitions:SettingDefinition[]=[
  {key:'RESOLUTION',label:'Resolution',type:'string',defaultValue:config.resolution,restartRequired:false,validate(value){if(typeof value!=='string')throw new Error('RESOLUTION must be a string');resolutionToSeconds(value);return value.toLowerCase();}},
  {key:'AUTO_TRADE',label:'Auto trade',type:'boolean',defaultValue:config.autoTrade,restartRequired:false,validate(value){if(typeof value!=='boolean')throw new Error('AUTO_TRADE must be boolean');return value;}},
  numberSetting('POLL_MS','Poll interval (ms)',config.pollMs,250,60_000,true),
  numberSetting('EMA_LENGTH','EMA length',config.emaLen,2,2_000,true),
  numberSetting('SLOPE_LOOKBACK','Slope lookback',config.slopeLookback,1,500,true),
  numberSetting('ENTRY_VALID_CANDLES','Entry valid candles',config.entryValidCandles,1,100,true),
  numberSetting('RR','Risk/reward',config.rr,0.1,100),
  numberSetting('RISK_PCT','Risk percent',config.riskPct,0.01,100),
  choiceSetting('RISK_BASE','Risk base',config.riskBase,['equity','available']),
  numberSetting('MAX_DAILY_CONSECUTIVE_LOSSES','Maximum daily consecutive losses',config.maxDailyLosses,1,100,true),
  numberSetting('MIN_STOP_PCT','Minimum stop percent',config.minStopPct,0,100),
  numberSetting('MAX_EFFECTIVE_LEVERAGE','Maximum effective leverage',config.maxEffectiveLeverage,1,1000),
  numberSetting('MAX_FEE_RISK_PCT','Maximum fee/risk percent',config.maxFeeRiskPct,0,100),
  numberSetting('GST_PCT','GST percent',config.gstPct,0,100),
  numberSetting('ORDER_LEVERAGE','Order leverage',config.orderLeverage,1,1000),
  choiceSetting('PRICE_SOURCE','Price source',config.priceSource,['mark','last','spot'])
];

const definitionsByKey=new Map(runtimeSettingDefinitions.map(definition=>[definition.key,definition]));
export function validateRuntimeSettings(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Settings must be an object');
  const values:Record<string,RuntimeSettingValue>={};
  for(const [key,value] of Object.entries(input)){const definition=definitionsByKey.get(key);if(!definition)throw new Error(`Unknown or protected setting: ${key}`);values[key]=definition.validate(value);}
  return values;
}
export function runtimeSettingDefaults(){return Object.fromEntries(runtimeSettingDefinitions.map(definition=>[definition.key,definition.defaultValue]));}
export function runtimeSettingMetadata(){return runtimeSettingDefinitions.map(({validate,...definition})=>definition);}
