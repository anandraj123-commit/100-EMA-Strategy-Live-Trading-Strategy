'use client';

import { FormEvent, useState } from 'react';

export default function LoginForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to sign in');
      window.location.assign('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in');
      setBusy(false);
    }
  }

  return (
    <main className="loginShell">
      <section className="loginCard" aria-labelledby="login-title">
        <div className="loginMark" aria-hidden="true">XA</div>
        <p className="eyebrow">SECURE OPERATIONS CONSOLE</p>
        <h1 id="login-title">Trading Dashboard</h1>
        <p className="loginIntro">Sign in with your administrator account to view and control the live algorithm.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={busy} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} />
          {error && <p className="loginError" role="alert">{error}</p>}
          <button type="submit" className="loginButton" disabled={busy}>{busy ? 'SIGNING IN…' : 'SIGN IN'}</button>
        </form>
        <p className="loginFoot">Authorized access only · Session expires after 8 hours</p>
      </section>
    </main>
  );
}
