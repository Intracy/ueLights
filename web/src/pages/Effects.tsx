import { useEffect, useState } from 'react';
import {
  CONNECTOR_LABELS,
  EFFECT_KIND_LABELS,
  PIXEL_ONLY_KINDS,
  defaultEffect,
  newId,
  type ConnectorType,
  type Effect,
  type EffectKind,
  type Light,
} from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Dialog, EffectPreview, Field, Icon, NumberInput, Segmented, Switch, TopBar, confirmDelete } from '../ui';

export function EffectsPage({ selectedId }: { selectedId?: string }) {
  const [tab, setTab] = useState<'own' | 'native'>(selectedId === 'native' ? 'native' : 'own');
  return (
    <>
      <TopBar title="Effekte" />
      <div className="page">
        <Segmented
          label="Effektart"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'own', label: 'Eigene' },
            { value: 'native', label: 'Hersteller' },
          ]}
        />
        {tab === 'own' ? <OwnEffects selectedId={selectedId} /> : <NativeEffects />}
      </div>
    </>
  );
}

function OwnEffects({ selectedId }: { selectedId?: string }) {
  const { effects, alerts, settings, save, remove, run } = useData();
  const [editing, setEditing] = useState<Effect | null>(null);

  useEffect(() => {
    const e = effects.find((x) => x.id === selectedId);
    if (e) setEditing(structuredClone(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const usage = (id: string) =>
    alerts.filter((a) => [...a.tracks, ...a.tiers.flatMap((t) => t.tracks)].some((t) => t.effect.type === 'own' && t.effect.effectId === id)).map((a) => a.name);

  return (
    <>
      <div className="grid-3">
        {effects.map((e) => {
          const used = usage(e.id);
          return (
            <div key={e.id} className="card" style={{ gap: 12 }}>
              <div className="row">
                <h3 className="grow">{e.name}</h3>
                <span className="tag">{EFFECT_KIND_LABELS[e.kind]}</span>
              </div>
              <EffectPreview effect={e} leds={40} maxFlashHz={settings.safety.maxFlashHz} amount={e.amountMapping ? (e.amountMapping.min + e.amountMapping.max) / 2 : undefined} />
              <span className="small muted mono">
                {(e.durationMs / 1000).toLocaleString('de-DE')} s · {e.speed.toLocaleString('de-DE')}/s{e.amountMapping ? ' · Betrag' : ''}
              </span>
              <span className="small muted">{used.length ? `In ${used.length} Alert${used.length > 1 ? 's' : ''}: ${used.join(', ')}` : 'Noch in keinem Alert'}</span>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn text" onClick={() => setEditing(structuredClone(e))}>
                  <Icon name="edit" />
                  Bearbeiten
                </button>
                <span className="grow" />
                <button className="icon-btn" aria-label="Duplizieren" onClick={() => run(() => save('effects', { ...structuredClone(e), id: newId('fx'), name: `${e.name} (Kopie)` }), 'Effekt dupliziert')}>
                  <Icon name="content_copy" />
                </button>
                <button
                  className="icon-btn"
                  aria-label="Löschen"
                  onClick={() => {
                    if (used.length && !window.confirm(`„${e.name}“ wird in ${used.length} Alert(s) benutzt. Trotzdem löschen?`)) return;
                    if (!used.length && !confirmDelete(e.name)) return;
                    run(() => remove('effects', e.id), 'Effekt gelöscht');
                  }}
                >
                  <Icon name="delete" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="fab" onClick={() => setEditing(defaultEffect(newId('fx')))}>
        <Icon name="add" />
        Neuer Effekt
      </button>
      {editing && <EffectEditor effect={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EffectEditor({ effect, onClose }: { effect: Effect; onClose: () => void }) {
  const { lights, settings, save, run } = useData();
  const [e, setE] = useState<Effect>(effect);
  const [testLight, setTestLight] = useState(lights.find((l) => l.enabled && l.role === 'deco')?.id ?? '');
  const [testAmount, setTestAmount] = useState<number | undefined>(e.amountMapping ? e.amountMapping.max / 2 : undefined);
  const set = (p: Partial<Effect>) => setE((x) => ({ ...x, ...p }));
  const multiColor = !['static', 'rainbow'].includes(e.kind);

  return (
    <Dialog
      title={effect.name}
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            onClick={async () => {
              const ok = await run(() => save('effects', e), 'Effekt gespeichert');
              if (ok) onClose();
            }}
          >
            Speichern
          </button>
        </>
      }
    >
      <EffectPreview effect={e} leds={60} maxFlashHz={settings.safety.maxFlashHz} amount={testAmount} />
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Field label="Name">
          <input value={e.name} onChange={(ev) => set({ name: ev.target.value })} />
        </Field>
        <Field label="Art" hint={PIXEL_ONLY_KINDS.includes(e.kind) ? 'Läuft auf Twinkly pro LED, auf anderen Lichtern vereinfacht als Puls/Helligkeit.' : undefined}>
          <select value={e.kind} onChange={(ev) => set({ kind: ev.target.value as EffectKind })}>
            {Object.entries(EFFECT_KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {e.kind !== 'rainbow' && (
        <div className="field">
          <span>Farben</span>
          <div className="row" style={{ gap: 8 }}>
            {e.colors.map((c, i) => (
              <div key={i} className="row" style={{ gap: 2 }}>
                <input
                  type="color"
                  aria-label={`Farbe ${i + 1}`}
                  value={c}
                  onChange={(ev) => set({ colors: e.colors.map((x, j) => (j === i ? ev.target.value : x)) })}
                  style={{ width: 48, height: 40, border: '1px solid var(--outline)', borderRadius: 8, background: 'none', padding: 2 }}
                />
                {e.colors.length > 1 && (
                  <button className="icon-btn" style={{ width: 28, flexBasis: 28 }} aria-label="Farbe entfernen" onClick={() => set({ colors: e.colors.filter((_, j) => j !== i) })}>
                    <Icon name="close" style={{ fontSize: 18 }} />
                  </button>
                )}
              </div>
            ))}
            {multiColor && e.colors.length < 6 && (
              <button className="chip" onClick={() => set({ colors: [...e.colors, '#3de0e8'] })}>
                <Icon name="add" />
                Farbe
              </button>
            )}
          </div>
          {(e.kind === 'chase' || e.kind === 'fill') && <span className="hint">Farbe 2 = Hintergrund</span>}
        </div>
      )}
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Field label="Helligkeit %" compact>
          <NumberInput value={e.brightness} min={1} max={100} onChange={(v) => set({ brightness: v })} />
        </Field>
        {['pulse', 'strobe', 'chase', 'fill'].includes(e.kind) && (
          <Field label="Mindesthelligkeit %" compact>
            <NumberInput value={e.brightnessMin} min={0} max={100} onChange={(v) => set({ brightnessMin: v })} />
          </Field>
        )}
        <Field label="Dauer (s)" compact>
          <NumberInput value={e.durationMs / 1000} min={0.2} max={120} onChange={(v) => set({ durationMs: Math.round(v * 1000) })} />
        </Field>
        <Field
          label="Tempo (pro s)"
          compact
          hint={['strobe', 'pulse', 'colorCycle'].includes(e.kind) && e.speed > settings.safety.maxFlashHz ? `Begrenzt auf ${settings.safety.maxFlashHz}/s (Flacker-Schutz)` : undefined}
        >
          <NumberInput value={e.speed} min={0.05} max={20} onChange={(v) => set({ speed: v })} />
        </Field>
        <Field label="Einblenden (s)" compact>
          <NumberInput value={e.fadeInMs / 1000} min={0} onChange={(v) => set({ fadeInMs: Math.round(v * 1000) })} />
        </Field>
        <Field label="Ausblenden (s)" compact>
          <NumberInput value={e.fadeOutMs / 1000} min={0} onChange={(v) => set({ fadeOutMs: Math.round(v * 1000) })} />
        </Field>
      </div>

      <div className="card" style={{ background: 'var(--surface)', gap: 12 }}>
        <Switch
          checked={!!e.amountMapping}
          onChange={(v) => set({ amountMapping: v ? { target: e.kind === 'fill' ? 'fill' : 'brightness', min: 1, max: 50 } : undefined })}
          label="Betrag als Parameter"
        />
        {e.amountMapping && (
          <div className="row">
            <Field label="Betrag steuert" compact>
              <select value={e.amountMapping.target} onChange={(ev) => set({ amountMapping: { ...e.amountMapping!, target: ev.target.value as 'brightness' | 'fill' | 'duration' } })}>
                <option value="brightness">Helligkeit</option>
                <option value="fill">Füllstand</option>
                <option value="duration">Dauer (50–150 %)</option>
              </select>
            </Field>
            <Field label="0 % bei" compact>
              <NumberInput value={e.amountMapping.min} onChange={(v) => set({ amountMapping: { ...e.amountMapping!, min: v } })} style={{ width: 100 }} />
            </Field>
            <Field label="100 % bei" compact>
              <NumberInput value={e.amountMapping.max} onChange={(v) => set({ amountMapping: { ...e.amountMapping!, max: v } })} style={{ width: 100 }} />
            </Field>
            <Field label="Vorschau-Betrag" compact>
              <NumberInput value={testAmount} onChange={setTestAmount} style={{ width: 100 }} />
            </Field>
          </div>
        )}
      </div>

      {lights.length > 0 && (
        <div className="row">
          <Field label="Auf echtem Licht testen" compact>
            <select value={testLight} onChange={(ev) => setTestLight(ev.target.value)}>
              {lights.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {CONNECTOR_LABELS[l.connector]}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn tonal" style={{ alignSelf: 'flex-end' }} onClick={() => run(() => api.post('/api/effects/preview', { effect: e, lightId: testLight, amount: testAmount }), 'Wird abgespielt')}>
            <Icon name="play_arrow" />
            Abspielen
          </button>
        </div>
      )}
    </Dialog>
  );
}

function NativeEffects() {
  const { lights, run, setLightLocal } = useData();
  const [filter, setFilter] = useState<ConnectorType | 'all'>('all');
  const [importFor, setImportFor] = useState<Light | null>(null);
  const capable = lights.filter((l) => l.connector !== 'virtual');
  const connectors = [...new Set(capable.map((l) => l.connector))];
  const shown = capable.filter((l) => filter === 'all' || l.connector === filter);

  const refresh = async (l: Light) => {
    const next = await run(() => api.post<Light>(`/api/lights/${l.id}/natives/refresh`), `${l.name}: Effekte eingelesen`);
    if (next) setLightLocal(next);
  };

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        Effekte und Szenen, die in den Apps von Twinkly, Govee, amaran oder in Home Assistant gebaut wurden. Im Alert-Builder bei einer Licht-Spur unter „Hersteller“ wählbar.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button className={`chip ${filter === 'all' ? 'selected' : ''}`} onClick={() => setFilter('all')}>
          Alle
        </button>
        {connectors.map((c) => (
          <button key={c} className={`chip ${filter === c ? 'selected' : ''}`} onClick={() => setFilter(c)}>
            {CONNECTOR_LABELS[c]}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="empty">Noch keine Lichter mit Hersteller-Effekten. Lege unter „Lichter“ eines an.</div>}
      {shown.map((l) => (
        <section key={l.id} className="card">
          <div className="row">
            <h3 className="grow">
              {l.name} <span className="tag">{CONNECTOR_LABELS[l.connector]}</span>
            </h3>
            {l.connector === 'govee' && (
              <button className="btn outlined" onClick={() => setImportFor(l)}>
                <Icon name="upload" />
                Szenen importieren
              </button>
            )}
            {l.connector !== 'govee' && (
              <button className="btn tonal" onClick={() => refresh(l)}>
                <Icon name="sync" />
                Neu einlesen
              </button>
            )}
          </div>
          {l.nativeEffects.length === 0 ? (
            <span className="small muted">
              {l.connector === 'twinkly'
                ? 'Keine Effekte gefunden. In der Twinkly-App gewünschte Effekte in die Playlist der Kette legen, dann neu einlesen.'
                : l.connector === 'govee'
                  ? 'Govee-Geräte können ihre Szenen nicht selbst auflisten. Importiere den Szenen-Katalog deines Modells (JSON).'
                  : 'Noch nichts eingelesen.'}
            </span>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              {l.nativeEffects.map((n) => (
                <button key={n.id} className="chip" title={`${n.kind} · abspielen`} onClick={() => run(() => api.post(`/api/lights/${l.id}/natives/${encodeURIComponent(n.id)}/play`), `${n.name} läuft 5 s`)}>
                  <Icon name="play_arrow" />
                  {n.name}
                  <span className="mono small muted">{n.kind}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
      {importFor && <SceneImport light={importFor} onClose={() => setImportFor(null)} />}
    </>
  );
}

function SceneImport({ light, onClose }: { light: Light; onClose: () => void }) {
  const { run, setLightLocal } = useData();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(true);
  const submit = async () => {
    let catalog: unknown;
    try {
      catalog = JSON.parse(text);
    } catch {
      return run(() => Promise.reject(new Error('Kein gültiges JSON')));
    }
    const next = await run(() => api.post<Light>(`/api/lights/${light.id}/natives/import`, { catalog, replace }), 'Szenen importiert');
    if (next) {
      setLightLocal(next);
      onClose();
    }
  };
  return (
    <Dialog
      title={`Govee-Szenen für ${light.name}`}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={submit} disabled={!text.trim()}>
            Importieren
          </button>
        </>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        Formate: Govee-Szenenbibliothek des Modells (<span className="mono">data.categories[].scenes[]</span>), eine Liste{' '}
        <span className="mono">[{'{'}"name","sceneCode","sceneParam"{'}'}]</span> oder mitgeschnittene Befehle <span className="mono">[{'{'}"name","commands":[…]{'}'}]</span>. Die Szenen
        werden lokal per LAN (ptReal) ausgelöst. Details in der README.
      </p>
      <label className="btn outlined" style={{ alignSelf: 'flex-start' }}>
        <Icon name="description" />
        Datei wählen
        <input
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
      </label>
      <Field label="JSON">
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </Field>
      <Switch checked={replace} onChange={setReplace} label="Vorhandene Szenen ersetzen" />
    </Dialog>
  );
}
