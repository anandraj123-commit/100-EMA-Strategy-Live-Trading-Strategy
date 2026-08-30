'use client';

import { useEffect, useState } from 'react';

export default function TradingDashboard() {
  const [s, setS] = useState<any>({});
  const [controlBusy, setControlBusy] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [tradeStats, setTradeStats] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);

  async function load() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
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

  async function loadHistory() {
    try {
      const [statsResponse,tradesResponse]=await Promise.all([fetch('/api/trades/stats',{cache:'no-store'}),fetch('/api/trades?limit=25',{cache:'no-store'})]);
      if(statsResponse.status===401||tradesResponse.status===401){window.location.replace('/login');return;}
      if(statsResponse.ok) setTradeStats(await statsResponse.json());
      if(tradesResponse.ok) setTrades((await tradesResponse.json()).trades||[]);
    } catch { /* retain the last history view during a temporary failure */ }
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
    loadHistory();
    const timer = setInterval(load, 3000);
    const historyTimer = setInterval(loadHistory, 15000);
    return () => { clearInterval(timer); clearInterval(historyTimer); };
  }, []);

  async function control(running: boolean) {
    if (controlBusy || !csrfToken) return;

    setControlBusy(true);

    try {
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ running })
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
    ['Position Source', s.activeTrade?.source === 'exchange_existing' ? 'EXISTING DELTA POSITION' : s.activeTrade?.source === 'bot' ? 'BOT' : s.activeTrade?.source === 'unattributed' ? 'UNKNOWN / UNATTRIBUTED' : '—'],
    ['Synced Stop Loss', s.activeTrade?.sl ?? 'NOT SET'],
    ['Synced Take Profit', s.activeTrade?.tp ?? 'NOT SET'],
    ['Daily Loss Streak', s.lossStreak],
    ['Current State', displayStatus(s.currentStatus?.action || s.decision?.action, s.currentStatus?.reason || s.decision?.reason)]
  ];

  return (
    <main>
      <div className="dashboardHead">
        <h1>XAUTUSD <span>// DELTA LIVE ALGO</span></h1>
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
        {cards.map(([label, value]) => (
          <div className="card" key={label}>
            <small>{label}</small>
            <strong>{value ?? '—'}</strong>
          </div>
        ))}
      </section>

      <div className="performanceGrid">
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
      </div>

      <div className="panel tradeHistoryPanel"><h2>Persistent Trade History</h2><div className="tableScroll"><table><thead><tr><th>Symbol</th><th>Source</th><th>Side</th><th>Entry Time</th><th>Actual Entry</th><th>Exit Time</th><th>Actual Exit</th><th>Qty</th><th>SL</th><th>TP</th><th>Exit</th><th>Gross P/L</th><th>Actual Brokerage</th><th>Estimated Brokerage</th><th>Actual GST</th><th>Estimated GST</th><th>Actual Charges</th><th>Estimated Charges</th><th>Actual Net P/L</th><th>Estimated Net P/L</th><th>R (actual net)</th><th>Status</th></tr></thead><tbody>{trades.map(t=><tr key={t.tradeId}><td>{t.symbol}</td><td>{t.source==='bot'?'BOT':'MANUAL'}</td><td>{t.side}</td><td>{t.entryTime?new Date(t.entryTime).toLocaleString():'—'}</td><td>{money(t.actualEntryPrice)}</td><td>{t.exitTime?new Date(t.exitTime).toLocaleString():'—'}</td><td>{money(t.actualExitPrice)}</td><td>{money(t.quantity)}</td><td>{money(t.initialSL)}</td><td>{money(t.takeProfit)}</td><td>{t.exitReason}</td><td>{money(t.grossPnL)}</td><td>{money(t.brokerage)}</td><td>{money(t.estimatedBrokerage)}</td><td>{money(t.GST)}</td><td>{money(t.estimatedGST)}</td><td>{money(t.totalCharges)}</td><td>{money(t.estimatedTotalCharges)}</td><td>{money(t.netPnL)}</td><td>{money(t.estimatedNetPnL)}</td><td>{money(t.realizedR)}</td><td>{t.financialStatus}</td></tr>)}{!trades.length&&<tr><td colSpan={22}>No persisted completed trades yet.</td></tr>}</tbody></table></div></div>


      <div className="panel">
        <h2>{s.strategy?.resolution ? `${s.strategy.resolution} Decision Log` : 'Decision Log'}</h2>
        <ul className="decisionLog">
          {(s.logs || []).map((log: any) => (
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
      </div>

      <div className="panel">
        <h2>Trade / Synchronisation Events</h2>
        <ul className="decisionLog">
          {(s.tradeEvents || []).map((event: any) => (
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
              </div>
            </li>
          ))}
          {(!s.tradeEvents || s.tradeEvents.length === 0) && <li>No trade/synchronisation event yet.</li>}
        </ul>
      </div>

      <div className="panel">
        <h2>Pending Setup</h2>
        <pre>{JSON.stringify(s.pending, null, 2)}</pre>
      </div>

      <div className="panel">
        <h2>Active Trade</h2>
        <pre>{JSON.stringify(s.activeTrade, null, 2)}</pre>
      </div>

      <div className="panel">
        <h2>Strategy / Guardrails</h2>
        <pre>{JSON.stringify(s.strategy, null, 2)}</pre>
      </div>

      <div className="panel">
        <h2>Latest Decision</h2>
        <pre>{JSON.stringify(s.decision, null, 2)}</pre>
      </div>
    </main>
  );
}
