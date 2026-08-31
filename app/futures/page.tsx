import { redirect } from 'next/navigation';
import Link from 'next/link';
import FuturesNav from '../../components/FuturesNav';
import { getServerSession } from '../../lib/auth/session';

export const metadata = { title: 'Futures Trading · Robot Platform' };
export const dynamic = 'force-dynamic';

export default async function FuturesPage() {
  const session = await getServerSession();
  if (!session) redirect('/login');
  return <main className="workspaceShell"><FuturesNav active="Future Trade"/><header className="workspaceHero"><span className="eyebrow">AUTOMATED TRADING WORKSPACES</span><h1>Future Trading</h1><p>Manage your instrument portfolio and access live or demo automated trading environments.</p></header><section className="workspaceChoices" aria-label="Future trading workspaces"><Link className="workspaceChoice enabled" href="/futures/portfolio"><span className="workspaceIcon">▦</span><small>INSTRUMENT MANAGEMENT</small><h2>PORTFOLIO</h2><p>Manage Delta Exchange instruments and trading portfolios.</p><b>OPEN PORTFOLIO →</b></Link><Link className="workspaceChoice enabled" href="/futures/live"><span className="workspaceIcon">↗</span><small>REAL ENVIRONMENT</small><h2>LIVE TRADE</h2><p>Production portfolio trading workspaces.</p><b>OPEN LIVE TRADE →</b></Link><Link className="workspaceChoice enabled" href="/futures/demo"><span className="workspaceIcon">◇</span><small>TESTNET ENVIRONMENT</small><h2>DEMO TRADE</h2><p>Demo portfolio trading workspaces.</p><b>OPEN DEMO TRADE →</b></Link></section></main>;
}
