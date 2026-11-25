import { useState } from 'react';
import { api } from '../api';
import { Field, Icon } from '../ui';

export function LoginPage({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (setup && pw !== pw2) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    try {
      await api.post(setup ? '/api/auth/setup' : '/api/auth/login', { password: pw });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form className="card glow" style={{ width: 'min(420px, 100%)', gap: 20 }} onSubmit={submit}>
        <div className="row">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <div>
            <h1>ueLights</h1>
            <span className="label">{setup ? 'Ersteinrichtung' : 'Anmelden'}</span>
          </div>
        </div>
        {setup && <p className="muted" style={{ margin: 0 }}>Lege ein Passwort für die Web-App fest (mindestens 8 Zeichen).</p>}
        <Field label="Passwort">
          <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        {setup && (
          <Field label="Passwort wiederholen">
            <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
        )}
        {error && (
          <div className="chip err" role="alert" style={{ height: 'auto', padding: '8px 12px' }}>
            <Icon name="error" />
            {error}
          </div>
        )}
        <button className="btn" type="submit" disabled={busy || !pw}>
          {setup ? 'Passwort festlegen' : 'Anmelden'}
        </button>
      </form>
    </div>
  );
}
