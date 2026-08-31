import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '../lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getServerSession();
  if (!session) redirect('/login');
  return <main className="platformHome">
    <header className="platformHero">
      <span className="eyebrow">ROBOT PLATFORM</span>
      <h1>Choose your trading market</h1>
      <p>Welcome back, {session.user.email}. Select a platform to continue.</p>
    </header>
    <section className="marketChoices" aria-label="Trading platforms">
      <Link className="marketChoice marketChoiceActive" href="/futures">
        <span className="marketChoiceTag">AVAILABLE</span>
        <strong>FUTURE TRADE</strong>
        <p>Open the complete futures trading dashboard.</p>
        <span className="marketChoiceAction">Launch Dashboard →</span>
      </Link>
      <div className="marketChoice marketChoiceDisabled" aria-disabled="true">
        <span className="marketChoiceTag">COMING SOON</span>
        <strong>OPTION TRADE</strong>
        <p>Options trading is currently unavailable.</p>
        <span className="marketChoiceAction">Disabled</span>
      </div>
    </section>
  </main>;
}
