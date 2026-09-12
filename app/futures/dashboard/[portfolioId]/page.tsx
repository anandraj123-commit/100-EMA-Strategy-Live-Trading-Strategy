import { notFound,redirect } from 'next/navigation';
import FuturesNav from '../../../../components/FuturesNav';
import TradingDashboard from '../../../../components/TradingDashboard';
import { getAppMode } from '../../../../lib/app-mode';
import { getServerSession } from '../../../../lib/auth/session';
import { findPortfolioById } from '../../../../lib/portfolio/repository';
export const dynamic='force-dynamic';
export default async function Workspace({params}:{params:Promise<{portfolioId:string}>}){
  if(!await getServerSession())redirect('/login');
  const {portfolioId}=await params;
  if(!await findPortfolioById(portfolioId))notFound();
  return <><FuturesNav active="Trade"/><TradingDashboard portfolioId={portfolioId} appMode={getAppMode()}/></>;
}
