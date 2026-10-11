import { useEffect, useState, type ReactNode } from 'react';
import { ensureSession, errorCode, isConfigured, supabase } from '../lib/supabase';

/**
 * Wraps the TV and /admin. Signs in anonymously, then requires the host passcode
 * once per device. The passcode check happens in Postgres (claim_host), and the
 * resulting host flag is what lets this device read answer keys.
 */
export function HostGate({ children, label }: { children: ReactNode; label: string }) {
  const [state, setState] = useState<'checking' | 'locked' | 'ok' | 'error'>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isConfigured) return;
    (async () => {
      try {
        await ensureSession();
        const { data, error } = await supabase.rpc('is_host');
        if (error) throw error;
        setState(data ? 'ok' : 'locked');
      } catch (e) {
        setMessage(errorCode(e));
        setState('error');
      }
    })();
  }, []);

  if (!isConfigured) return <SetupNeeded />;

  if (state === 'ok') return <>{children}</>;

  if (state === 'checking') {
    return (
      <div className="screen center-stack">
        <div className="spinner" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="screen center-stack narrow">
        <h1 className="display">Can't reach Supabase</h1>
        <p className="error">{message}</p>
        <p className="dim">
          Check that anonymous sign-ins are enabled and the migration has been run. See README → Setup.
        </p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.rpc('claim_host', { p_passcode: pass });
      if (error) throw error;
      if (data) setState('ok');
      else setMessage('Wrong passcode');
    } catch (e) {
      const code = errorCode(e);
      setMessage(code === 'NO_PASSCODE_SET' ? 'No passcode set yet. Run set_host_passcode in the SQL editor (README → Setup).' : code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen center-stack narrow">
      <h1 className="display">{label}</h1>
      <p className="dim">Enter the host passcode. You only need to do this once on this device.</p>
      <form
        className="stack gap"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="input input-lg"
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="Passcode"
          autoComplete="current-password"
        />
        <button className="btn btn-primary btn-lg" disabled={busy || !pass}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
      {message && <p className="error">{message}</p>}
    </div>
  );
}

export function SetupNeeded() {
  return (
    <div className="screen center-stack narrow">
      <h1 className="display">Almost there</h1>
      <p>
        Copy <code>.env.example</code> to <code>.env</code>, add your Supabase URL and anon key, then restart{' '}
        <code>npm run dev</code>.
      </p>
      <p className="dim">See README.md → Setup.</p>
    </div>
  );
}
