import { redirect } from 'next/navigation';
import { getServerSession } from '../../../lib/auth/session';
export const dynamic='force-dynamic';
export default async function ExistingDashboardPage(){const session=await getServerSession();if(!session)redirect('/login');redirect('/futures');}
