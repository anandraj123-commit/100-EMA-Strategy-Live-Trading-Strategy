import { redirect } from 'next/navigation';
import { getServerSession } from '../../../../lib/auth/session';
export const dynamic='force-dynamic';
export default async function LegacyWorkspace({params}:{params:Promise<{portfolioId:string}>}){if(!await getServerSession())redirect('/login');const {portfolioId}=await params;redirect(`/futures/dashboard/${encodeURIComponent(portfolioId)}`);}
