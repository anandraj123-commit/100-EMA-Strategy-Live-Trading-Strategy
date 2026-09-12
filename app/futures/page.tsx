import { getAppMode } from '../../lib/app-mode';
import AppModeBadge from '../../components/AppModeBadge';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import FuturesNav from '../../components/FuturesNav';
import { getServerSession } from '../../lib/auth/session';

export const metadata = { title: 'Futures Trading · Robot Platform' };
export const dynamic = 'force-dynamic';

export default async function FuturesPage() {
  const session = await getServerSession();
  if (!session) redirect('/login');
  return <main className="workspaceShell"><FuturesNav active="Future Trade"/><header className="workspaceHero"><span className="eyebrow">AUTOMATED TRADING WORKSPACES</span><h1>Future Trading <AppModeBadge appMode={getAppMode()}/></h1><p>Manage your instrument portfolio and access automated trading in this application mode.</p></header><section className="workspaceChoices" aria-label="Future trading workspaces"><Link className="workspaceChoice enabled" href="/futures/portfolio"><span className="workspaceIcon">▦</span><small>INSTRUMENT MANAGEMENT</small><h2>PORTFOLIO</h2><p>Manage Delta Exchange instruments and trading portfolios.</p><b>OPEN PORTFOLIO →</b></Link><Link className="workspaceChoice enabled" href="/futures/dashboard"><span className="workspaceIcon">↗</span><small>{getAppMode().toUpperCase()}</small><h2>TRADE</h2><p>Portfolio trading workspaces for this application.</p><b>OPEN TRADE →</b></Link></section></main>;
}
