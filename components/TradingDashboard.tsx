'use client';

import { useEffect, useState } from 'react';
import { calculateCurrentPnL, paginateItems } from '../lib/dashboard';

const tabs=['Environment Variables','Profit','History','Decision Log','Trade / Synchronisation Events','Pending Setup','Active Trade','Strategy / Guardrails','Latest Decision'] as const;

export default function TradingDashboard({portfolioId}:{portfolioId:string}) {
  const portfolioQuery=`portfolioId=${encodeURIComponent(portfolioId)}`;
  const [s, setS] = useState<any>({});
  const [controlBusy, setControlBusy] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [tradeStats, setTradeStats] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [historyPage,setHistoryPage]=useState(1);
  const [historyPagination,setHistoryPagination]=useState<any>({page:1,totalPages:1,total:0});
  const [activeTab,setActiveTab]=useState<(typeof tabs)[number]>('Environment Variables');
  const [logPage,setLogPage]=useState(1);
  const [eventPage,setEventPage]=useState(1);
  const [settings,setSettings]=useState<any[]>([]);
  const [settingValues,setSettingValues]=useState<Record<string,string|number|boolean>>({});
  const [savedSettingValues,setSavedSettingValues]=useState<Record<string,string|number|boolean>>({});
  const [settingsEditing,setSettingsEditing]=useState(false);
  const [settingsBusy,setSettingsBusy]=useState(false);
  const [settingsError,setSettingsError]=useState('');

  async function load() {
    try {
      const res = await fetch(`/api/status?${portfolioQuery}`, { cache: 'no-store' });
      if (res.status === 401) {
        setS({});
        setCsrfToken('');
        window.location.replace('/login');
        return;
      }
      if (!res.ok) throw new Error(`Status request failed: HTTP ${res.status}`);
      setS(await res.json());
    } catch {
      // Keep the last visible status if a refresh fails temporarily.
    }
  }

  async function loadHistory(page=historyPage) {
    try {
      const [statsResponse,tradesResponse]=await Promise.all([fetch(`/api/trades/stats?${portfolioQuery}`,{cache:'no-store'}),fetch(`/api/trades?${portfolioQuery}&page=${page}&limit=20`,{cache:'no-store'})]);
      if(statsResponse.status===401||tradesResponse.status===401){window.location.replace('/login');return;}
      if(statsResponse.ok) setTradeStats(await statsResponse.json());
      if(tradesResponse.ok){const data=await tradesResponse.json();setTrades(data.trades||[]);setHistoryPagination({page:data.page,totalPages:data.totalPages||1,total:data.total||0});}
    } catch { /* retain the last history view during a temporary failure */ }
  }

  async function loadSettings(){
    setSettingsError('');
    try{const response=await fetch(`/api/settings?${portfolioQuery}`,{cache:'no-store'});if(response.status===401||response.status===403){if(response.status===401)window.location.replace('/login');throw new Error('Administrator access is required');}if(!response.ok)throw new Error(`Settings request failed: HTTP ${response.status}`);const data=await response.json();setSettings(data.definitions||[]);setSettingValues(data.values||{});setSavedSettingValues(data.values||{});}catch(error:any){setSettingsError(error?.message||'Unable to load settings');}
  }

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401) {
          setS({});
          setCsrfToken('');
          window.location.replace('/login');
          return;
        }
        if (!res.ok) throw new Error(`Session request failed: HTTP ${res.status}`);
        const data = await res.json();
        setCsrfToken(data.csrfToken || '');
      })
      .catch(() => setS((prev: any) => ({ ...prev, error: 'Unable to initialize secure session' })));
    load();
    loadHistory(1);
    loadSettings();
    const timer = setInterval(load, 3000);
    const historyTimer = setInterval(loadHistory, 15000);
    return () => { clearInterval(timer); clearInterval(historyTimer); };
  }, []);

  async function saveSettings(){
    if(!settingsEditing||!csrfToken)return;setSettingsBusy(true);setSettingsError('');
    try{const response=await fetch('/api/settings',{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify({portfolioId,values:settingValues})});const data=await response.json();if(!response.ok)throw new Error(data.error||`Save failed: HTTP ${response.status}`);setSettingValues(data.values);setSavedSettingValues(data.values);setSettingsEditing(false);}catch(error:any){setSettingsError(error?.message||'Unable to save settings');}finally{setSettingsBusy(false);}
  }

  async function control(running: boolean) {
    if (controlBusy || !csrfToken) return;

    setControlBusy(true);

    try {
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ portfolioId, running })
      });

      if (!res.ok) {
        throw new Error(`Control request failed: HTTP ${res.status}`);
      }

      // Update immediately so the correct button appears without waiting
      // for the next 3-second status refresh.
      setS((prev: any) => ({ ...prev, running }));
      await load();
    } catch (error: any) {
      setS((prev: any) => ({
        ...prev,
        error: error?.message || 'Unable to change robot state'
      }));
    } finally {
      setControlBusy(false);
    }
  }

  async function logout() {
    if (!csrfToken || controlBusy) return;
    setControlBusy(true);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } });
      if (!res.ok) throw new Error('Logout failed');
      window.location.assign('/login');
    } catch {
      setS((prev: any) => ({ ...prev, error: 'Unable to log out safely' }));
      setControlBusy(false);
    }
  }

  const running = s.running === true;
  const deltaOnline = s.connection?.state !== 'offline';
  const money=(value:any)=>value==null?'—':Number(value).toFixed(4);
  const coveredValue=(scope:any,valueField:string,completeField:string)=>scope?.totalTrades===0?'0.0000':scope?.[completeField]?money(scope[valueField]):'—';
  const coverage=(scope:any,reportedField:string)=>`${scope?.[reportedField]??0} / ${scope?.totalTrades??0}`;
  const currentPnL=calculateCurrentPnL({positionSize:s.position?.size,entryPrice:s.position?.entryPrice,currentPrice:s.price,contractValue:s.contractValue});
  const pnlClass=currentPnL.value==null||currentPnL.value===0?'neutral':currentPnL.value>0?'profit':'loss';
  const pagedLogs=paginateItems(s.logs||[],logPage,10),pagedEvents=paginateItems(s.tradeEvents||[],eventPage,10);

  function displayStatus(action?: string, reason?: string) {
    if (action === 'ENTRY' && reason === 'ALGO_POSITION_OPEN') return 'ENTRY · ALGO POSITION OPEN';
    if (action === 'ACTIVE' && reason === 'EXISTING_POSITION') return 'ACTIVE · EXISTING POSITION';
    if (action === 'ENTRY' && reason === 'ORDER_SENT') return 'ENTRY · ORDER SENT';
    if (action === 'ENTRY' && reason === 'TRADE_APPROVED') return 'ENTRY · TRADE APPROVED';
    if (action === 'STOPPED' && reason === 'POSITION_STILL_OPEN') return 'STOPPED · POSITION STILL OPEN';
    if (action === 'STOPPED' && reason === 'ROBOT_STOPPED') return 'STOPPED · NO NEW TRADES';
    if (action === 'STOPPED' && reason === 'ROBOT_STOPPED_BEFORE_ORDER') return 'STOPPED · ORDER BLOCKED';
    return `${action || '—'} · ${(reason || '—').replaceAll('_', ' ')}`;
  }

  function displayEvent(type?: string) {
    if (type === 'EXCHANGE_POSITION_ADOPTED') return 'ACTIVE · EXISTING POSITION';
    if (type === 'ORDER_SENT') return 'ENTRY · ORDER SENT';
    if (type === 'BRACKET_SENT') return 'PROTECTION · BRACKET SENT';
    if (type === 'SL_SYNCED_FROM_EXCHANGE') return 'SYNC · STOP LOSS UPDATED';
    if (type === 'TP_SYNCED_FROM_EXCHANGE') return 'SYNC · TAKE PROFIT UPDATED';
    if (type === 'SL_REMOVED_ON_EXCHANGE') return 'SYNC · STOP LOSS REMOVED';
    if (type === 'TP_REMOVED_ON_EXCHANGE') return 'SYNC · TAKE PROFIT REMOVED';
    if (type === 'POSITION_CLOSED') return 'EXIT · POSITION CLOSED';
    if (type === 'ORDER_BLOCKED_ROBOT_STOPPED') return 'STOPPED · ORDER BLOCKED';
    if (type === 'CONNECTION_LOST') return 'NETWORK · OFFLINE';
    if (type === 'CONNECTION_RESTORED') return 'NETWORK · ONLINE AGAIN';
    return (type || '—').replaceAll('_', ' ');
  }

  const cards = [
    ['Robot Status', running ? 'RUNNING' : 'STOPPED'],
    ['Delta Connection', deltaOnline ? 'ONLINE' : 'OFFLINE'],
    ['Delta Monitoring', deltaOnline ? 'CONNECTED / ACTIVE' : 'RECONNECTING…'],
    ['New Algo Entries', running ? 'ENABLED' : 'DISABLED'],
    ['Environment', s.env],
    ['Auto Trade', String(s.autoTrade)],
    ['Symbol', s.symbol],
    ['Resolution', s.strategy?.resolution],
    ['Strategy Price', s.price],
    ['Price Source', s.priceSource],
    ['Candle Source', s.strategy?.candleSource],
    ['EMA History Bars', s.strategy?.candleHistoryBars],
    ['Mark Price', s.markPrice],
    ['Last Traded Price', s.lastTradedPrice],
    ['Spot Price', s.spotPrice],
    ['Wallet Equity', s.equity],
    ['Available', s.available],
    ['Position Size', s.position?.size],
    ['Entry Price', s.position?.entryPrice],
    ['Current P/L', currentPnL.value==null?'—':money(currentPnL.value),pnlClass],
    ['Current P/L %', currentPnL.percentage==null?'—':`${Number(currentPnL.percentage).toFixed(2)}%`,pnlClass],
    ['Position Source', s.activeTrade?.source === 'exchange_existing' ? 'EXISTING DELTA POSITION' : s.activeTrade?.source === 'bot' ? 'BOT' : s.activeTrade?.source === 'unattributed' ? 'UNKNOWN / UNATTRIBUTED' : '—'],
    ['Synced Stop Loss', s.activeTrade?.sl ?? 'NOT SET'],
    ['Synced Take Profit', s.activeTrade?.tp ?? 'NOT SET'],
    ['Daily Loss Streak', s.lossStreak],
    ['Current State', displayStatus(s.currentStatus?.action || s.decision?.action, s.currentStatus?.reason || s.decision?.reason)]
  ];

  return (
    <main>
      <div className="dashboardHead">
        <h1>{s.symbol||'PORTFOLIO'} <span>// DELTA {s.environment==='demo'?'DEMO':'LIVE'} ALGO</span></h1>
        <button type="button" className="logout" onClick={logout} disabled={!csrfToken || controlBusy}>LOG OUT</button>
      </div>

      <p className="sub">
        EMA100 reclaim/rejection breakout · one position at a time · exchange-side SL/TP
      </p>

      <div className={`connectionBadge ${deltaOnline ? 'online' : 'offline'}`}>
        <span className="connectionDot" />
        {deltaOnline ? 'DELTA ONLINE' : 'DELTA OFFLINE · RECONNECTING'}
      </div>

      <div className="buttons">
        {running ? (
          <button
            type="button"
            className="stopRobot"
            onClick={() => control(false)}
            disabled={controlBusy}
          >
            {controlBusy ? 'STOPPING…' : 'STOP ROBOT'}
          </button>
        ) : (
          <button
            type="button"
            className="startRobot"
            onClick={() => control(true)}
            disabled={controlBusy}
          >
            {controlBusy ? 'STARTING…' : 'START ROBOT'}
          </button>
        )}
      </div>

      {s.error && <pre className="error">{s.error}</pre>}

      <section>
        {cards.map(([label, value, tone]) => (
          <div className="card" key={label}>
            <small>{label}</small>
            <strong className={tone}>{value ?? '—'}</strong>
          </div>
        ))}
      </section>

      <nav className="dashboardTabs" aria-label="Dashboard sections">
        {tabs.map(tab=><button type="button" key={tab} className={activeTab===tab?'active':''} aria-selected={activeTab===tab} onClick={()=>setActiveTab(tab)}>{tab}</button>)}
      </nav>

      {activeTab==='Environment Variables'&&<div className="panel settingsPanel"><div className="panelHead"><div><h2>Environment Variables</h2><p>Safe settings only. Changes take effect after the worker is restarted.</p></div>{!settingsEditing?<button type="button" onClick={()=>setSettingsEditing(true)} disabled={!settings.length}>Enable Edit</button>:<div className="inlineButtons"><button type="button" onClick={saveSettings} disabled={settingsBusy}>{settingsBusy?'Saving…':'Save'}</button><button type="button" className="secondary" onClick={()=>{setSettingValues(savedSettingValues);setSettingsEditing(false);setSettingsError('');}} disabled={settingsBusy}>Cancel</button></div>}</div>{settingsError&&<p className="settingsError">{settingsError}</p>}<div className="settingsGrid">{settings.map((definition:any)=><label key={definition.key}><span>{definition.label}<small>{definition.key} · restart required</small></span>{definition.type==='boolean'?<select disabled={!settingsEditing} value={String(settingValues[definition.key])} onChange={event=>setSettingValues(values=>({...values,[definition.key]:event.target.value==='true'}))}><option value="true">true</option><option value="false">false</option></select>:<input disabled={!settingsEditing} type={definition.type==='number'?'number':'text'} value={String(settingValues[definition.key]??'')} onChange={event=>setSettingValues(values=>({...values,[definition.key]:definition.type==='number'?Number(event.target.value):event.target.value}))}/>}</label>)}</div>{!settings.length&&!settingsError&&<p>Loading settings…</p>}</div>}

      {activeTab==='Profit'&&<div className="performanceGrid">
        {([['ACCOUNT TOTAL',tradeStats?.account],['BOT PERFORMANCE',tradeStats?.bot],['MANUAL PERFORMANCE',tradeStats?.manual]] as const).map(([title,scope])=>(
          <div className="panel performanceCard" key={title}>
            <h2>{title}</h2>
            <strong className="netValue">{title==='ACCOUNT TOTAL'?'ACCOUNT':title.split(' ')[0]} NET P/L: {coveredValue(scope,'netPnL','netPnLComplete')}</strong>
            <div className="statRows">
              <span>Trades <b>{scope?.totalTrades??0}</b></span>
              <span>{scope?.grossPnLComplete||scope?.totalTrades===0?'Gross P/L':'Known Gross P/L'} <b>{scope?.grossPnLComplete||scope?.totalTrades===0?money(scope?.grossPnL):money(scope?.grossPnL)}</b></span><span>Gross P/L Coverage <b>{coverage(scope,'grossPnLReportedTrades')}</b></span>
              <span>{scope?.brokerageComplete||scope?.totalTrades===0?'Brokerage Paid':'Known Brokerage'} <b>{scope?.brokerageComplete||scope?.totalTrades===0?money(scope?.brokerage):money(scope?.brokerage)}</b></span><span>Brokerage Coverage <b>{coverage(scope,'brokerageReportedTrades')}</b></span>
              <span>{scope?.gstComplete||scope?.totalTrades===0?'GST Paid':'Known GST'} <b>{scope?.gstComplete||scope?.totalTrades===0?money(scope?.GST):money(scope?.GST)}</b></span><span>GST Coverage <b>{coverage(scope,'gstReportedTrades')}</b></span>
              <span>Total Charges <b>{coveredValue(scope,'totalCharges','totalChargesComplete')}</b></span><span>Charges Coverage <b>{coverage(scope,'totalChargesReportedTrades')}</b></span>
              <span>Net P/L Coverage <b>{coverage(scope,'fullyReconciledTrades')}</b></span>
              {title!=='ACCOUNT TOTAL'&&<span>Gross Win Rate <b>{Number(scope?.winRate??0).toFixed(2)}%</b></span>}
            </div>
          </div>
        ))}
      </div>}

      {activeTab==='History'&&<div className="panel tradeHistoryPanel"><h2>Persistent Trade History</h2><div className="tableScroll"><table><thead><tr><th>Symbol</th><th>Source</th><th>Side</th><th>Entry Time</th><th>Actual Entry</th><th>Exit Time</th><th>Actual Exit</th><th>Qty</th><th>SL</th><th>TP</th><th>Exit</th><th>Gross P/L</th><th>Actual Brokerage</th><th>Estimated Brokerage</th><th>Actual GST</th><th>Estimated GST</th><th>Actual Charges</th><th>Estimated Charges</th><th>Actual Net P/L</th><th>Estimated Net P/L</th><th>R (actual net)</th><th>Status</th></tr></thead><tbody>{trades.map(t=><tr key={t.tradeId}><td>{t.symbol}</td><td>{t.source==='bot'?'BOT':'MANUAL'}</td><td>{t.side}</td><td>{t.entryTime?new Date(t.entryTime).toLocaleString():'—'}</td><td>{money(t.actualEntryPrice)}</td><td>{t.exitTime?new Date(t.exitTime).toLocaleString():'—'}</td><td>{money(t.actualExitPrice)}</td><td>{money(t.quantity)}</td><td>{money(t.initialSL)}</td><td>{money(t.takeProfit)}</td><td>{t.exitReason}</td><td>{money(t.grossPnL)}</td><td>{money(t.brokerage)}</td><td>{money(t.estimatedBrokerage)}</td><td>{money(t.GST)}</td><td>{money(t.estimatedGST)}</td><td>{money(t.totalCharges)}</td><td>{money(t.estimatedTotalCharges)}</td><td>{money(t.netPnL)}</td><td>{money(t.estimatedNetPnL)}</td><td>{money(t.realizedR)}</td><td>{t.financialStatus}</td></tr>)}{!trades.length&&<tr><td colSpan={22}>No persisted completed trades yet.</td></tr>}</tbody></table></div><Pagination pagination={historyPagination} onPage={page=>{setHistoryPage(page);loadHistory(page);}} /></div>}


      {activeTab==='Decision Log'&&<div className="panel">
        <h2>{s.strategy?.resolution ? `${s.strategy.resolution} Decision Log` : 'Decision Log'}</h2>
        <ul className="decisionLog">
          {pagedLogs.items.map((log: any) => (
            <li key={log.candleTime}>
              <div className="logHead">
                <strong>{new Date(log.candleTime * 1000).toLocaleString()}</strong>
                <span className={log.decision?.action === 'ENTRY' ? 'ok' : log.decision?.action === 'SKIP' ? 'bad' : 'wait'}>
                  {displayStatus(log.decision?.action || 'WAIT', log.decision?.reason || '—')}
                </span>
              </div>
              <div className="logGrid">
                <span>OHLC: {log.candle?.open} / {log.candle?.high} / {log.candle?.low} / {log.candle?.close}</span>
                <span>EMA: {log.ema?.current ?? '—'} | {log.ema?.lookback} bars ago: {log.ema?.previous ?? '—'} | {log.ema?.direction ?? '—'}</span>
                <span>Feed: candles {log.price?.candleSource ?? 'traded_price'} | breakout {log.price?.source ?? s.priceSource ?? 'last'} | last {log.price?.last ?? '—'} | mark {log.price?.mark ?? '—'}</span>
                <span>BUY: slope {log.buy?.slope ? 'PASS' : 'FAIL'}, A {log.buy?.patternA ? 'YES' : 'NO'}, B {log.buy?.patternB ? 'YES' : 'NO'}, setup {log.buy?.setup ? 'YES' : 'NO'}</span>
                <span>SELL: slope {log.sell?.slope ? 'PASS' : 'FAIL'}, A {log.sell?.patternA ? 'YES' : 'NO'}, B {log.sell?.patternB ? 'YES' : 'NO'}, setup {log.sell?.setup ? 'YES' : 'NO'}</span>
                {log.setup && <span>Setup: {log.setup.direction.toUpperCase()} | Trigger {log.setup.trigger} | SL {log.setup.sl}</span>}
                {log.breakout && <span>Breakout: {log.breakout.passed ? 'YES' : 'NO'} | Price {log.breakout.currentPrice} | Trigger {log.breakout.trigger}</span>}
                {log.risk && <span>Risk: ${Number(log.risk.riskAmount).toFixed(4)} | Contracts {log.risk.contracts} | TP {log.risk.tp} | Leverage {Number(log.risk.effectiveLeverage).toFixed(2)}x | Fee/Risk {Number(log.risk.feeRiskPct).toFixed(2)}%</span>}
                {log.order && <span>Order: {log.order.side?.toUpperCase()} MARKET {log.order.market} | ID {log.order.orderId ?? '—'} | Bracket {log.order.bracket ?? '—'}</span>}
              </div>
            </li>
          ))}
          {(!s.logs || s.logs.length === 0) && <li>No completed-candle log yet.</li>}
        </ul>
        <Pagination pagination={pagedLogs.pagination} onPage={setLogPage}/>
      </div>}

      {activeTab==='Trade / Synchronisation Events'&&<div className="panel">
        <h2>Trade / Synchronisation Events</h2>
        <ul className="decisionLog">
          {pagedEvents.items.map((event: any) => (
            <li key={event.id}>
              <div className="logHead">
                <strong>{new Date(event.at).toLocaleString()}</strong>
                <span className={event.type?.includes('REMOVED') || event.type === 'CONNECTION_LOST' ? 'bad' : 'ok'}>{displayEvent(event.type)}</span>
              </div>
              <div className="logGrid">
                {event.orderId != null && <span>Order ID: {event.orderId}</span>}
                {event.side && <span>Side: {event.side}</span>}
                {event.breakoutPrice != null && <span>Breakout Price: {event.breakoutPrice}</span>}
                {event.positionSize != null && <span>Position Size: {event.positionSize}</span>}
                {event.entryPrice != null && <span>Entry Price: {event.entryPrice}</span>}
                {event.source && <span>Source: {event.source}</span>}
                {event.sl != null && <span>SL: {event.sl}</span>}
                {event.tp != null && <span>TP: {event.tp}</span>}
                {event.oldValue !== undefined && <span>Old: {event.oldValue ?? 'NOT SET'} → New: {event.newValue ?? 'NOT SET'}</span>}
                {event.classifiedAs && <span>Close classification: {event.classifiedAs}</span>}
                {event.reason && <span>Reason: {event.reason}</span>}
                {event.error && <span>Error: {event.error}</span>}
                {event.retry && <span>Retry: {event.retry}</span>}
              </div>
            </li>
          ))}
          {(!s.tradeEvents || s.tradeEvents.length === 0) && <li>No trade/synchronisation event yet.</li>}
        </ul>
        <Pagination pagination={pagedEvents.pagination} onPage={setEventPage}/>
      </div>}

      {activeTab==='Pending Setup'&&<div className="panel">
        <h2>Pending Setup</h2>
        {s.pending?<pre>{JSON.stringify(s.pending,null,2)}</pre>:<p>No pending setup</p>}
      </div>}

      {activeTab==='Active Trade'&&<div className="panel">
        <h2>Active Trade</h2>
        {s.activeTrade?<><div className="activePnl"><span>Current P/L <b className={pnlClass}>{money(currentPnL.value)}</b></span><span>Current P/L % <b className={pnlClass}>{currentPnL.percentage==null?'—':`${currentPnL.percentage.toFixed(2)}%`}</b></span></div><pre>{JSON.stringify(s.activeTrade,null,2)}</pre></>:<p>No active trade</p>}
      </div>}

      {activeTab==='Strategy / Guardrails'&&<div className="panel">
        <h2>Strategy / Guardrails</h2>
        <pre>{JSON.stringify(s.strategy, null, 2)}</pre>
      </div>}

      {activeTab==='Latest Decision'&&<div className="panel">
        <h2>Latest Decision</h2>
        <pre>{JSON.stringify(s.decision, null, 2)}</pre>
      </div>}
    </main>
  );
}

function Pagination({pagination,onPage}:{pagination:any;onPage:(page:number)=>void}){return <div className="pagination"><button type="button" className="secondary" disabled={!pagination?.hasPrevious} onClick={()=>onPage(pagination.page-1)}>Previous</button><span>Page {pagination?.page??1} of {pagination?.totalPages??1} · {pagination?.total??0} items</span><button type="button" className="secondary" disabled={!pagination?.hasNext} onClick={()=>onPage(pagination.page+1)}>Next</button></div>}
