import { useEffect, useState } from 'react';
import { api } from './api';
import { DataProvider, useData } from './data';
import { Icon, useHashRoute } from './ui';
import { LoginPage } from './pages/Login';
import { LivePage } from './pages/Live';
import { AlertsPage } from './pages/Alerts';
import { AlertBuilder } from './pages/AlertBuilder';
import { EffectsPage } from './pages/Effects';
import { LightsPage } from './pages/Lights';
import { SettingsPage } from './pages/Settings';

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  disabled: boolean;
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const check = () => api.get<AuthStatus>('/api/auth/status').then(setAuth).catch(() => setAuth({ configured: true, authenticated: false, disabled: false }));
  useEffect(() => {
    check();
  }, []);
  if (!auth) return null;
  if (!auth.authenticated) return <LoginPage setup={!auth.configured} onDone={check} />;
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  );
}

const DESTS = [
  { id: 'live', label: 'Live', icon: 'sensors' },
  { id: 'alerts', label: 'Alerts', icon: 'notifications_active' },
  { id: 'effects', label: 'Effekte', icon: 'auto_awesome' },
  { id: 'lights', label: 'Lichter', icon: 'lightbulb' },
];

function Shell() {
  const route = useHashRoute();
  const [expanded, setExpanded] = useState(() => localStorage.getItem('uel_rail') === '1');
  const { toasts, online } = useData();
  const section = route[0];

  useEffect(() => {
    try {
      localStorage.setItem('uel_rail', expanded ? '1' : '0');
    } catch {
      /* egal */
    }
  }, [expanded]);

  let page;
  if (section === 'alerts' && route[1]) page = <AlertBuilder id={route[1]} />;
  else if (section === 'alerts') page = <AlertsPage />;
  else if (section === 'effects') page = <EffectsPage selectedId={route[1]} />;
  else if (section === 'lights') page = <LightsPage />;
  else if (section === 'settings') page = <SettingsPage />;
  else page = <LivePage />;

  const builder = section === 'alerts' && !!route[1];

  return (
    <div className="shell">
      {!builder && (
        <nav className={`rail ${expanded ? 'expanded' : ''}`} aria-label="Hauptnavigation">
          <button className="icon-btn" aria-label={expanded ? 'Navigation einklappen' : 'Navigation ausklappen'} onClick={() => setExpanded(!expanded)} style={{ alignSelf: expanded ? 'flex-start' : 'center' }}>
            <Icon name={expanded ? 'menu_open' : 'menu'} />
          </button>
          <a className="fab-rail" href="#/alerts/new" aria-label="Neuer Alert">
            <Icon name="add" />
            {expanded && 'Neuer Alert'}
          </a>
          {DESTS.map((d) => (
            <a key={d.id} href={`#/${d.id}`} className={`rail-item ${section === d.id ? 'active' : ''}`} aria-current={section === d.id ? 'page' : undefined}>
              <span className="pill">
                <Icon name={d.icon} />
              </span>
              {d.label}
            </a>
          ))}
          <div className="rail-section" style={{ marginTop: 'auto' }}>
            <a href="#/settings" className={`rail-item ${section === 'settings' ? 'active' : ''}`}>
              <span className="pill">
                <Icon name="tune" />
              </span>
              Einstellungen
            </a>
          </div>
          <span className="small mono muted" title={online ? 'Live-Verbindung aktiv' : 'Live-Verbindung getrennt'} style={{ display: 'flex', gap: 6, alignItems: 'center', color: online ? '#a8f5c0' : '#ff8fa8', alignSelf: 'center' }}>
            <span className="dot" />
            {expanded ? (online ? 'live' : 'offline') : ''}
          </span>
        </nav>
      )}
      <div className="main">{page}</div>
      {!builder && (
        <nav className="navbar" aria-label="Hauptnavigation">
          {[...DESTS, { id: 'settings', label: 'Mehr', icon: 'more_horiz' }].map((d) => (
            <a key={d.id} href={`#/${d.id}`} className={`rail-item ${section === d.id ? 'active' : ''}`} aria-current={section === d.id ? 'page' : undefined}>
              <span className="pill">
                <Icon name={d.icon} />
              </span>
              {d.label}
            </a>
          ))}
        </nav>
      )}
      <div className="snackbar" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`snack ${t.level === 'error' ? 'error' : ''}`}>
            <Icon name={t.level === 'error' ? 'error' : 'check_circle'} style={{ color: t.level === 'error' ? 'var(--error)' : 'var(--secondary)' }} />
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
