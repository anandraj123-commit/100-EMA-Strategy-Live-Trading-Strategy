import Link from 'next/link';
import { listPortfolio } from '../lib/portfolio/repository';
import { portfolioWithPrices } from '../lib/portfolio/service';
import { readStatus } from '../lib/state';
import { validateStatusMode } from '../lib/runtime/status-mode';
import { getAppMode } from '../lib/app-mode';
export default async function TradeWorkspaceList(){const rows=await portfolioWithPrices(await listPortfolio());return rows.length?<div className="portfolioGrid">{rows.map(row=>{const status=validateStatusMode(readStatus(row.id),getAppMode());return <Link className="portfolioCard workspacePortfolioCard" href={`/futures/dashboard/${row.id}`} key={row.id}><span className="portfolioType">{getAppMode().toUpperCase()}</span><h2>{row.symbol}</h2><dl><div><dt>Current Price</dt><dd>{row.currentPrice??'Unavailable'}</dd></div><div><dt>Robot Status</dt><dd>{status.statusAvailable===false?'UNAVAILABLE':status.running?'RUNNING':'STOPPED'}</dd></div><div><dt>Position Status</dt><dd>{status.statusAvailable===false?'UNAVAILABLE':Number((status.position as any)?.size||0)!==0?'OPEN':'FLAT'}</dd></div></dl></Link>;})}</div>:<section className="portfolioEmpty"><h2>No {getAppMode().toUpperCase()} portfolios.</h2><p>Add an instrument from Portfolio first.</p><Link href="/futures/portfolio">Open Portfolio</Link></section>;}
