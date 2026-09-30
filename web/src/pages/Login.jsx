import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, setToken, errorText } from '../api.js';
import { Alert, Button } from '../ui.jsx';
import { Aurora, CursorFX } from '../fx.jsx';

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') await api.post('/auth/register', { email, password });
      const { data } = await api.post('/auth/login', { email, password });
      setToken(data.token);
      navigate('/');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const input = 'min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[15px]';
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Aurora />
      <CursorFX />
      <div className="stagger flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col gap-3">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-xs font-semibold text-brand">
            <span className="live-dot" /> Predictive health for ageing laptops
          </div>
          <div className="bg-gradient-to-r from-ink via-brand to-sim bg-clip-text text-5xl font-bold tracking-tight text-transparent">DevicePulse</div>
          <p className="m-0 text-lg text-muted">
            Early warnings with the evidence behind every finding. Built for schools, clinics and small offices.
          </p>
        </div>
        <form onSubmit={submit} className="glass spot flex flex-col gap-4 rounded-2xl border border-white/10 p-7 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)]">
          <h1 className="m-0 text-xl font-semibold">{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
          {error && <Alert>{error}</Alert>}
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Email
            <input className={input} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Password
            <input
              className={input}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'register' && <span className="text-xs font-normal text-muted">At least 8 characters.</span>}
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          <button
            type="button"
            className="min-h-11 text-sm font-semibold text-brand hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
