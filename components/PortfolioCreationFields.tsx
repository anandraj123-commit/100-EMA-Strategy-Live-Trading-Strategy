import React from 'react';
import type { AppMode } from '../lib/app-mode';
import AppModeBadge from './AppModeBadge';

export default function PortfolioCreationFields({appMode,symbol,busy,input,onSymbolChange}:{
  appMode:AppMode;symbol:string;busy:boolean;input:React.Ref<HTMLInputElement>;onSymbolChange:(value:string)=>void;
}){
  return <><label htmlFor="portfolio-symbol">Delta Exchange Symbol</label><input ref={input} id="portfolio-symbol" value={symbol} placeholder="BTCUSD" maxLength={30} disabled={busy} onChange={event=>onSymbolChange(event.target.value.trimStart().toUpperCase())}/><small>Examples: BTCUSD, XAUTUSD</small><p>Application Mode: <AppModeBadge appMode={appMode}/></p></>;
}
