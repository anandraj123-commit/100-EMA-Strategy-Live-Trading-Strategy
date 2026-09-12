import { redirect } from 'next/navigation';
import FuturesNav from '../../../components/FuturesNav';
import TradeWorkspaceList from '../../../components/TradeWorkspaceList';
import AppModeBadge from '../../../components/AppModeBadge';
import { getAppMode } from '../../../lib/app-mode';
import { getServerSession } from '../../../lib/auth/session';
export const dynamic='force-dynamic';
export default async function TradingPage(){
  if(!await getServerSession())redirect('/login');
  return <main className="workspaceShell"><FuturesNav active="Trade"/><header className="portfolioHero"><h1>Trade <AppModeBadge appMode={getAppMode()}/></h1><p>Portfolio trading workspaces.</p></header><TradeWorkspaceList/></main>;
}
