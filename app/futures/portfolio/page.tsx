import { getAppMode } from '../../../lib/app-mode';
import AppModeBadge from '../../../components/AppModeBadge';
import { redirect } from 'next/navigation';
import FuturesNav from '../../../components/FuturesNav';
import PortfolioManager from '../../../components/PortfolioManager';
import { getServerSession } from '../../../lib/auth/session';
export const metadata={title:'Portfolio · Future Trading'};export const dynamic='force-dynamic';
export default async function PortfolioPage(){const session=await getServerSession();if(!session)redirect('/login');return <main className="workspaceShell"><FuturesNav active="Portfolio"/><header className="portfolioHero"><span className="eyebrow">FUTURE TRADING</span><h1>Portfolio <AppModeBadge appMode={getAppMode()}/></h1><p>Manage the Delta Exchange instruments available to your automated trading platform.</p></header><PortfolioManager appMode={getAppMode()}/></main>;}
