import { redirect } from 'next/navigation';
import LoginForm from '../../components/LoginForm';
import { getServerSession } from '../../lib/auth/session';

export const metadata = { title: 'Secure Login · XAUTUSD Delta Live Algo' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await getServerSession();
  if (session) redirect('/');
  return <LoginForm />;
}
