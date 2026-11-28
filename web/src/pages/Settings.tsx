import { useEffect, useState } from 'react';
import type { Settings } from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Field, Icon, NumberInput, Segmented, Switch, TopBar } from '../ui';

export function SettingsPage() {
  const { settings, saveSettings, run, reload, live } = useData();
  const [s, setS] = useState<Settings>(() => strip(settings));
  const [dirty, setDirty] = useState(false);
  const [modeTouched, setModeTouched] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [fxText, setFxText] = useState(() => fxToText(settings.events.fxRates));

  useEffect(() => {
    if (!dirty) {
      setS(strip(settings));
      setFxText(fxToText(settings.events.fxRates));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => {
    setS((x) => ({ ...x, [k]: typeof x[k] === 'object' ? { ...(x[k] as object), ...v } : v }));
    setDirty(true);
  };
  const conn = (id: string) => live.connections.find((c) => c.id === id);

  const doSave = async () => {
    const fxRates: Record<string, number> = {};
    for (const line of fxText.split('\n')) {
      const m = line.match(/^\s*([A-Za-z]{3})\s*[=:]\s*([0-9.,]+)\s*$/);
      if (m) fxRates[m[1].toUpperCase()] = Number(m[2].replace(',', '.'));
    }
    const next: Settings = {
      ...s,
      // Pause und Auslösung können sich inzwischen über die Kopfleiste geändert haben
      triggerMode: modeTouched ? s.triggerMode : live.triggerMode,
      safety: { ...s.safety, paused: live.paused },
      events: { ...s.events, fxRates },
    };
    const ok = await run(async () => {
      await saveSettings(next);
      return true;
    }, 'Einstellungen gespeichert');
    if (ok) {
      setDirty(false);
      setModeTouched(false);
    }
  };

  return (
    <>
      <TopBar title="Einstellungen">
        <button className="btn" onClick={doSave} disabled={!dirty}>
          <Icon name="save" />
          Speichern
        </button>
      </TopBar>
      <div className="page">
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="card">
            <div className="row">
              <h2 className="grow">StreamElements</h2>
              <StatusText state={conn('streamelements')?.state} detail={conn('streamelements')?.detail} />
            </div>
            <Switch checked={s.streamelements.enabled} onChange={(v) => up('streamelements', { enabled: v })} label="Verbindung aktiv" />
            <Field
              label="JWT-Token"
              hint={
                settings.meta.jwtFromEnv
                  ? 'Wird per Umgebungsvariable SE_JWT gesetzt.'
                  : 'StreamElements-Dashboard → Avatar → Kanal → „Show secrets“ → JWT Token. Bleibt nur auf diesem Server.'
              }
            >
              <input type="password" autoComplete="off" value={s.streamelements.jwt} placeholder="eyJhbGciOi…" disabled={settings.meta.jwtFromEnv} onChange={(e) => up('streamelements', { jwt: e.target.value })} />
            </Field>
            <Field label="Kanal-ID (optional)" hint={settings.meta.detectedChannelId ? `Aus dem Token erkannt: ${settings.meta.detectedChannelId}` : 'Wird normalerweise aus dem Token gelesen.'}>
              <input value={s.streamelements.channelId} onChange={(e) => up('streamelements', { channelId: e.target.value.trim() })} />
            </Field>
            <span className="label">Topics</span>
            <Switch checked={s.streamelements.topics.activities} onChange={(v) => up('streamelements', { topics: { ...s.streamelements.topics, activities: v } })} label="Aktivitäten (Spenden, Bits, Subs, Raids, Kanalpunkte …)" />
            <Switch checked={s.streamelements.topics.chat} onChange={(v) => up('streamelements', { topics: { ...s.streamelements.topics, chat: v } })} label="Chat-Nachrichten (für Chat-Befehle)" />
            <Switch checked={s.streamelements.topics.tips} onChange={(v) => up('streamelements', { topics: { ...s.streamelements.topics, tips: v } })} label="Zusätzlich channel.tips (Duplikate werden gefiltert)" />
          </section>

          <section className="card">
            <h2>Auslösung</h2>
            <Segmented
              label="Auslösung"
              value={modeTouched ? s.triggerMode : live.triggerMode}
              onChange={(v) => {
                setS((x) => ({ ...x, triggerMode: v }));
                setModeTouched(true);
                setDirty(true);
              }}
              options={[
                { value: 'auto', label: 'Automatisch' },
                { value: 'manual', label: 'Manuell' },
              ]}
            />
            <p className="small muted" style={{ margin: 0 }}>
              <strong>Automatisch</strong> (Standard): Eingehende StreamElements-Alerts lösen die passenden Licht-Alerts sofort aus.{' '}
              <strong>Manuell</strong>: Passende Alerts warten im Live-Feed, bis du sie freigibst oder verwirfst. Einzelne Alerts können das im Alert-Builder übersteuern.
            </p>
          </section>

          <section className="card">
            <h2>Sicherheit</h2>
            <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <Field label="Max. Blitze pro Sekunde" compact hint="Flacker-Schutz für Zuschauer (Standard 3)">
                <NumberInput value={s.safety.maxFlashHz} min={0.5} max={10} onChange={(v) => up('safety', { maxFlashHz: v })} />
              </Field>
              <Field label="Events verwerfen nach (s)" compact hint="Ältere Events nach Reconnect nur protokollieren">
                <NumberInput value={s.safety.staleEventSec} min={5} onChange={(v) => up('safety', { staleEventSec: Math.round(v) })} />
              </Field>
              <Field label="Warteschlange max." compact>
                <NumberInput value={s.safety.queueMax} min={1} max={100} onChange={(v) => up('safety', { queueMax: Math.round(v) })} />
              </Field>
            </div>
            <Switch checked={s.safety.lockSceneLights} onChange={(v) => up('safety', { lockSceneLights: v })} label="Bildlichter für Alerts sperren" />
            <Switch checked={s.safety.quietHours.enabled} onChange={(v) => up('safety', { quietHours: { ...s.safety.quietHours, enabled: v } })} label="Ruhezeiten" />
            {s.safety.quietHours.enabled && (
              <div className="row">
                <Field label="von" compact>
                  <input type="time" value={s.safety.quietHours.from} onChange={(e) => up('safety', { quietHours: { ...s.safety.quietHours, from: e.target.value } })} />
                </Field>
                <Field label="bis" compact>
                  <input type="time" value={s.safety.quietHours.to} onChange={(e) => up('safety', { quietHours: { ...s.safety.quietHours, to: e.target.value } })} />
                </Field>
              </div>
            )}
          </section>

          <HueSection
            hue={s.hue}
            paired={!!settings.hue.appKey}
            status={conn('hue')}
            onChange={(v) => up('hue', v)}
          />

          <section className="card">
            <div className="row">
              <h2 className="grow">Home Assistant</h2>
              <StatusText state={conn('homeassistant')?.state} detail={conn('homeassistant')?.detail} />
            </div>
            <Switch checked={s.homeassistant.enabled} onChange={(v) => up('homeassistant', { enabled: v })} label="Verbindung aktiv" />
            <Field label="Adresse">
              <input value={s.homeassistant.url} onChange={(e) => up('homeassistant', { url: e.target.value.trim() })} placeholder="http://192.168.178.30:8123" />
            </Field>
            <Field label="Long-Lived Access Token" hint={settings.meta.haTokenFromEnv ? 'Wird per Umgebungsvariable HA_TOKEN gesetzt.' : 'Home Assistant → Profil → Sicherheit → Langlebige Zugriffstoken'}>
              <input type="password" autoComplete="off" value={s.homeassistant.token} disabled={settings.meta.haTokenFromEnv} onChange={(e) => up('homeassistant', { token: e.target.value })} />
            </Field>
          </section>

          <section className="card">
            <div className="row">
              <h2 className="grow">amaran Desktop</h2>
              <StatusText state={conn('amaran')?.state} detail={conn('amaran')?.detail} />
            </div>
            <Switch checked={s.amaran.enabled} onChange={(v) => up('amaran', { enabled: v })} label="Verbindung aktiv" />
            <Field label="WebSocket-Adresse" hint="Rechner mit amaran Desktop, Standard-Port 33782. Die App muss während des Streams laufen.">
              <input value={s.amaran.url} onChange={(e) => up('amaran', { url: e.target.value.trim() })} />
            </Field>
            <Field
              label="OpenAPI-Key"
              hint={
                settings.meta.amaranKeyFromEnv
                  ? 'Wird per Umgebungsvariable AMARAN_API_KEY gesetzt.'
                  : 'Aus amaran Desktop → Benutzerzentrum → OpenAPI. Signiert jede Anfrage, bleibt im lokalen Netz.'
              }
            >
              <input
                type="password"
                autoComplete="off"
                value={s.amaran.apiKey ?? ''}
                disabled={!!settings.meta.amaranKeyFromEnv}
                onChange={(e) => up('amaran', { apiKey: e.target.value.trim() })}
              />
            </Field>
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Erweitert
              </summary>
              <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginTop: 12 }}>
                <Field label="Client-ID" compact>
                  <input value={s.amaran.clientId} onChange={(e) => up('amaran', { clientId: e.target.value })} />
                </Field>
                <Field label="Intensitäts-Skala" compact hint="1000 = Promille (aktuelle Desktop-App), 100 = Prozent">
                  <NumberInput value={s.amaran.intensityScale} min={1} onChange={(v) => up('amaran', { intensityScale: Math.round(v) })} />
                </Field>
                <Field label="Befehl für Presets" compact>
                  <input value={s.amaran.presetCommand} onChange={(e) => up('amaran', { presetCommand: e.target.value })} />
                </Field>
                <Field label="Befehl für Szenen" compact>
                  <input value={s.amaran.sceneCommand} onChange={(e) => up('amaran', { sceneCommand: e.target.value })} />
                </Field>
              </div>
            </details>
          </section>

          <section className="card">
            <h2>Events</h2>
            <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <Field label="Gift-Bomben bündeln (s)" compact>
                <NumberInput value={s.events.giftBundleWindowMs / 1000} min={1} onChange={(v) => up('events', { giftBundleWindowMs: Math.round(v * 1000) })} />
              </Field>
              <Field label="Kanalwährung" compact>
                <input value={s.events.channelCurrency} onChange={(e) => up('events', { channelCurrency: e.target.value.toUpperCase().slice(0, 3) })} />
              </Field>
              <Field label="Spenden in Fremdwährung" compact>
                <select value={s.events.foreignCurrency} onChange={(e) => up('events', { foreignCurrency: e.target.value as Settings['events']['foreignCurrency'] })}>
                  <option value="convert">mit festem Kurs umrechnen</option>
                  <option value="original">Originalbetrag nehmen</option>
                  <option value="ignore">ignorieren</option>
                </select>
              </Field>
            </div>
            <Field label="Feste Kurse (1 Fremdwährung = x Kanalwährung)" hint="Eine Zeile je Währung, z. B. USD=0,92. Kein Online-Abruf.">
              <textarea
                value={fxText}
                onChange={(e) => {
                  setFxText(e.target.value);
                  setDirty(true);
                }}
                style={{ minHeight: 90 }}
              />
            </Field>
          </section>

          <section className="card">
            <h2>Leistung</h2>
            <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <Field label="Echtzeit-Bilder pro s" compact hint="Twinkly und virtuelle Lichter">
                <NumberInput value={s.realtimeFps} min={5} max={40} onChange={(v) => up('realtimeFps', Math.round(v) as never)} />
              </Field>
              <Field label="Farbbefehle pro s" compact hint="Govee, amaran, Home Assistant">
                <NumberInput value={s.colorCommandRate} min={1} max={10} onChange={(v) => up('colorCommandRate', v as never)} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>Sicherung</h2>
            <p className="small muted" style={{ margin: 0 }}>
              Exportiert Alerts, Effekte, Lichter, Gruppen und Einstellungen – ohne JWT und Home-Assistant-Token.
            </p>
            <div className="row">
              <a className="btn tonal" href="/api/export" download>
                <Icon name="download" />
                Exportieren
              </a>
              <label className="btn outlined">
                <Icon name="upload" />
                Importieren
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (!window.confirm('Import ersetzt alle Alerts, Effekte, Lichter und Gruppen. Fortfahren?')) return;
                    const ok = await run(async () => api.post('/api/import', JSON.parse(await f.text())), 'Sicherung importiert');
                    if (ok) await reload();
                  }}
                />
              </label>
            </div>
          </section>

          <section className="card">
            <h2>Zugang</h2>
            {settings.meta.passwordFromEnv ? (
              <p className="small muted" style={{ margin: 0 }}>
                Das Passwort wird per Umgebungsvariable UELIGHTS_PASSWORD festgelegt.
              </p>
            ) : (
              <div className="row">
                <Field label="Aktuelles Passwort" compact>
                  <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                </Field>
                <Field label="Neues Passwort" compact>
                  <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </Field>
                <button
                  className="btn tonal"
                  style={{ alignSelf: 'flex-end' }}
                  disabled={!pw.current || pw.next.length < 8}
                  onClick={async () => {
                    const ok = await run(() => api.post('/api/auth/password', pw), 'Passwort geändert');
                    if (ok) setPw({ current: '', next: '' });
                  }}
                >
                  Ändern
                </button>
              </div>
            )}
            <button
              className="btn outlined"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                await api.post('/api/auth/logout');
                location.reload();
              }}
            >
              <Icon name="logout" />
              Abmelden
            </button>
          </section>
        </div>
      </div>
    </>
  );
}

function StatusText({ state, detail }: { state?: string; detail?: string }) {
  if (!state || state === 'disabled') return <span className="small muted">aus</span>;
  const color = state === 'ok' ? 'var(--on-success-container)' : state === 'error' ? 'var(--error)' : 'var(--on-surface-variant)';
  return (
    <span className="small" style={{ color, display: 'flex', gap: 6, alignItems: 'center' }} title={detail}>
      <span className="dot" />
      {state === 'ok' ? 'verbunden' : state === 'error' ? 'Fehler' : 'verbindet …'}
      {detail && <span className="muted mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}
    </span>
  );
}

function HueSection({
  hue,
  paired,
  status,
  onChange,
}: {
  hue: Settings['hue'];
  paired: boolean;
  status?: { state: string; detail?: string };
  onChange: (v: Partial<Settings['hue']>) => void;
}) {
  const { run, reload, notify } = useData();
  const [bridges, setBridges] = useState<Array<{ ip: string; name: string; bridgeId?: string }> | null>(null);
  const [busy, setBusy] = useState<'' | 'search' | 'pair' | 'import'>('');

  const search = async () => {
    setBusy('search');
    setBridges(null);
    const r = await run(() => api.get<Array<{ ip: string; name: string; bridgeId?: string }>>('/api/hue/bridges'));
    setBridges(r ?? []);
    if (r?.length === 1 && !hue.bridgeIp) onChange({ bridgeIp: r[0].ip });
    setBusy('');
  };
  const pair = async () => {
    setBusy('pair');
    const r = await run(() => api.post<{ ok: boolean }>('/api/hue/pair', { ip: hue.bridgeIp }), 'Hue Bridge gekoppelt');
    if (r) await reload();
    setBusy('');
  };
  const importAll = async () => {
    setBusy('import');
    const r = await run(() => api.post<{ added: number; groups: number; total: number }>('/api/hue/import'));
    if (r) {
      await reload();
      notify(`${r.added} von ${r.total} Hue-Lampen neu angelegt, ${r.groups} Raum-Gruppen`);
    }
    setBusy('');
  };

  return (
    <section className="card">
      <div className="row">
        <h2 className="grow">Philips Hue</h2>
        <StatusText state={status?.state as never} detail={status?.detail} />
      </div>
      <Switch checked={hue.enabled} onChange={(v) => onChange({ enabled: v })} label="Verbindung aktiv" />
      <div className="row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <div className="grow">
          <Field label="Bridge-Adresse" hint="Lokal über die Hue Bridge (API v2), ohne Hue-Cloud.">
            <input value={hue.bridgeIp} onChange={(e) => onChange({ bridgeIp: e.target.value.trim() })} placeholder="192.168.0.20" />
          </Field>
        </div>
        <button className="btn tonal" onClick={search} disabled={!!busy}>
          <Icon name={busy === 'search' ? 'hourglass_top' : 'radar'} />
          {busy === 'search' ? 'Suche …' : 'Suchen'}
        </button>
      </div>
      {bridges && bridges.length === 0 && <span className="small muted">Keine Bridge gefunden. Adresse aus der Hue-App (Einstellungen → Bridges) eintragen.</span>}
      {bridges && bridges.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {bridges.map((b) => (
            <button key={b.ip} className="chip" onClick={() => onChange({ bridgeIp: b.ip })}>
              <Icon name="router" />
              {b.name} <span className="mono small muted">{b.ip}</span>
            </button>
          ))}
        </div>
      )}
      <div className="card" style={{ background: 'var(--surface)', gap: 8 }}>
        <span className="small">
          {paired
            ? 'Gekoppelt. Zum erneuten Koppeln wieder die Link-Taste drücken.'
            : '1. Runde Link-Taste oben auf der Hue Bridge drücken. 2. Innerhalb von 30 Sekunden hier auf „Koppeln“ klicken.'}
        </span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={pair} disabled={!!busy || !hue.bridgeIp}>
            <Icon name={busy === 'pair' ? 'hourglass_top' : 'link'} />
            {paired ? 'Neu koppeln' : 'Koppeln'}
          </button>
          <button className="btn tonal" onClick={importAll} disabled={!!busy || !paired}>
            <Icon name={busy === 'import' ? 'hourglass_top' : 'playlist_add'} />
            Alle Hue-Lampen übernehmen
          </button>
        </div>
        <span className="small muted">Legt jede Lampe als Licht an und je Raum eine Gruppe. Räume und Zonen als Ganzes gibt es unter Lichter → Philips Hue → Suchen.</span>
      </div>
    </section>
  );
}

function strip(s: Settings & { meta?: unknown }): Settings {
  const { meta: _meta, ...rest } = s;
  return structuredClone(rest);
}

function fxToText(fx: Record<string, number>): string {
  return Object.entries(fx)
    .map(([k, v]) => `${k}=${String(v).replace('.', ',')}`)
    .join('\n');
}
