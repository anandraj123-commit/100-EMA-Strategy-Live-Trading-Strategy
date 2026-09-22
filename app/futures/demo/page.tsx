import { redirect } from 'next/navigation';
import { getServerSession } from '../../../lib/auth/session';
export const dynamic='force-dynamic';
export default async function LegacyWorkspaceList(){if(!await getServerSession())redirect('/login');redirect('/futures/dashboard');}
