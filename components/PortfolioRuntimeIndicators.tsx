'use client';
import { useEffect, useState } from 'react';
import type { PortfolioCardRuntime } from '../lib/portfolio/card-status';

export default function PortfolioRuntimeIndicators({runtime}:{runtime?:PortfolioCardRuntime}) {
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  const current=runtime&&runtime.expiresAt>=Math.max(now,Date.now())?runtime:undefined;
  const running=current?.running;
  const robot=running===true?'RUNNING':running===false?'STOPPED':'UNAVAILABLE';
  const trade=current?.trade??'UNAVAILABLE';
  const pnl=trade==='OPEN'?current?.pnl:null;
  const tone=pnl==null||pnl===0?'neutral':pnl>0?'positive':'negative';
  const value=pnl==null?'—':`${pnl>0?'+':pnl<0?'-':''}$${Math.abs(pnl).toFixed(2)}`;
  return <>
    <div><dt>Robot Status</dt><dd><span className={`portfolioRobotDot ${robot.toLowerCase()}`} role="img" aria-label={`Robot ${robot}`} title={`Robot ${robot}`}/></dd></div>
    <div><dt>Trade Status</dt><dd><span className={`portfolioTradeStatus ${trade.toLowerCase()}`}>{trade}</span></dd></div>
    <div><dt>Ongoing P/L</dt><dd className={`portfolioPnl ${tone}`}>{value}</dd></div>
  </>;
}
