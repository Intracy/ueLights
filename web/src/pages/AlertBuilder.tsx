import { useEffect, useMemo, useState } from 'react';
import {
  CONNECTOR_LABELS,
  EVENT_AMOUNT_UNIT,
  EVENT_TYPE_LABELS,
  describeAmount,
  effectiveDuration,
  newId,
  validateTiers,
  type Alert,
  type AmountCondition,
  type ConnectorType,
  type EventType,
  type Tier,
  type Track,
  type Light,
} from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Field, Icon, NumberInput, Segmented, Switch, TopBar } from '../ui';
import { useTrackLabel } from './Alerts';

function blankAlert(): Alert {
  return {
    id: '',
    name: 'Neuer Alert',
    enabled: true,
    trigger: 'tip',
    conditions: { amount: { mode: 'any' }, allowTest: true },
    mode: 'single',
    tracks: [],
    tiers: [],
    after: 'restore',
    cooldownMs: 0,
    overlap: 'exclusive',
    triggerMode: 'inherit',
  };
}

const AMOUNT_TYPES: EventType[] = ['tip', 'cheer', 'giftSub', 'raid', 'subscriber', 'superchat', 'channelPoints'];

/** Kanalpunkte-Belohnung wählen: Liste von Twitch (wenn angemeldet) oder Name frei eingeben */
function RewardPicker({ value, onChange }: { value?: string; onChange: (reward: string | undefined, cost?: number) => void }) {
  const { settings } = useData();
  const [rewards, setRewards] = useState<Array<{ id: string; title: string; cost: number; enabled: boolean }> | null>(null);
  const [err, setErr] = useState('');
  const connected = !!settings.twitch?.accessToken;
  useEffect(() => {
    if (!connected) return;
    api
      .get<Array<{ id: string; title: string; cost: number; enabled: boolean }>>('/api/twitch/rewards')
      .then(setRewards)
      .catch((e) => setErr((e as Error).message));
  }, [connected]);

  return (
    <Field
      label="Belohnung"
      hint={
        rewards
          ? 'Leer = jede Belohnung. Für „ab X Punkte“ oben Stufen nach Betrag verwenden.'
          : err || 'Genau wie in Twitch, Groß-/Kleinschreibung egal. Leer = jede Belohnung. Mit Twitch-Anmeldung gibt es hier eine Auswahlliste.'
      }
    >
      {rewards ? (
        <select
          value={value ?? ''}
          onChange={(e) => {
            const r = rewards.find((x) => x.title === e.target.value);
            onChange(e.target.value || undefined, r?.cost);
          }}
        >
          <option value="">jede Belohnung</option>
          {value && !rewards.some((r) => r.title === value) && <option value={value}>{value} (nicht mehr auf Twitch)</option>}
          {rewards.map((r) => (
            <option key={r.id} value={r.title}>
              {r.title} · {r.cost.toLocaleString('de-DE')} Punkte{r.enabled ? '' : ' (deaktiviert)'}
            </option>
          ))}
        </select>
      ) : (
        <input value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />
      )}
    </Field>
  );
}

export function AmountEditor({ value, onChange, unit }: { value: AmountCondition; onChange: (v: AmountCondition) => void; unit: string }) {
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <Field label="Betrag" compact>
        <select
          value={value.mode}
          onChange={(e) => {
            const m = e.target.value as AmountCondition['mode'];
            if (m === 'any') onChange({ mode: 'any' });
            if (m === 'exact') onChange({ mode: 'exact', value: 'min' in value ? value.min : 5 });
            if (m === 'range') onChange({ mode: 'range', min: 'min' in value ? value.min : value.mode === 'exact' ? value.value : 1, max: 9.99 });
            if (m === 'min') onChange({ mode: 'min', min: 'min' in value ? value.min : value.mode === 'exact' ? value.value : 10 });
          }}
        >
          <option value="any">jeder Betrag</option>
          <option value="exact">genau</option>
          <option value="range">von – bis</option>
          <option value="min">ab</option>
        </select>
      </Field>
      {value.mode === 'exact' && (
        <Field label={`Wert ${unit}`} compact>
          <NumberInput value={value.value} onChange={(v) => onChange({ ...value, value: v })} style={{ width: 110 }} />
        </Field>
      )}
      {(value.mode === 'range' || value.mode === 'min') && (
        <Field label={`von ${unit}`} compact>
          <NumberInput value={value.min} onChange={(v) => onChange({ ...value, min: v })} style={{ width: 110 }} />
        </Field>
      )}
      {value.mode === 'range' && (
        <Field label={`bis ${unit}`} compact>
          <NumberInput value={value.max} onChange={(v) => onChange({ ...value, max: v })} style={{ width: 110 }} />
        </Field>
      )}
    </div>
  );
}

function nextTier(tiers: Tier[], isMoney: boolean): Tier {
  const step = isMoney ? 0.01 : 1;
  const last = tiers[tiers.length - 1];
  let min = isMoney ? 1 : 100;
  if (last) {
    if (last.amount.mode === 'range') min = Math.round((last.amount.max + step) * 100) / 100;
    else if (last.amount.mode === 'min') min = last.amount.min * 2;
    else if (last.amount.mode === 'exact') min = last.amount.value + step;
  }
  return { id: newId('tier'), label: `Stufe ${tiers.length + 1}`, amount: { mode: 'min', min }, tracks: [] };
}

export function AlertBuilder({ id }: { id: string }) {
  const { alerts, lights, groups, effects, settings, save, run, notify } = useData();
  const existing = alerts.find((a) => a.id === id);
  const [draft, setDraft] = useState<Alert>(() => (existing ? structuredClone(existing) : blankAlert()));
  const [tierId, setTierId] = useState<string | undefined>(draft.tiers[0]?.id);
  const [dirty, setDirty] = useState(false);
  const label = useTrackLabel();

  useEffect(() => {
    if (existing && !dirty) setDraft(structuredClone(existing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);

  const update = (patch: Partial<Alert>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const unit = EVENT_AMOUNT_UNIT[draft.trigger] ?? '';
  const isMoney = draft.trigger === 'tip' || draft.trigger === 'superchat';
  const tier = draft.mode === 'tiers' ? draft.tiers.find((t) => t.id === tierId) ?? draft.tiers[0] : undefined;
  const tracks = draft.mode === 'tiers' ? tier?.tracks ?? [] : draft.tracks;
  const problems = draft.mode === 'tiers' ? validateTiers(draft.tiers) : [];

  const setTracks = (next: Track[]) => {
    if (draft.mode === 'tiers') {
      if (!tier) return;
      update({ tiers: draft.tiers.map((t) => (t.id === tier.id ? { ...t, tracks: next } : t)) });
    } else update({ tracks: next });
  };
  const setTier = (t: Tier) => update({ tiers: draft.tiers.map((x) => (x.id === t.id ? t : x)) });

  const trackDuration = (t: Track) => {
    if (t.durationMs) return t.durationMs;
    if (t.effect.type === 'own') {
      const eid = t.effect.effectId;
      const e = effects.find((x) => x.id === eid);
      return e ? effectiveDuration(e, undefined) : 5000;
    }
    return t.effect.type === 'eventColor' ? 8000 : 5000;
  };
  const total = Math.max(1000, ...tracks.map((t) => t.offsetMs + trackDuration(t)));

  const byConnector = useMemo(() => {
    const m = new Map<ConnectorType, typeof lights>();
    for (const l of lights) {
      const list = m.get(l.connector) ?? [];
      list.push(l);
      m.set(l.connector, list);
    }
    return m;
  }, [lights]);

  const doSave = async () => {
    if (!draft.name.trim()) return notify('Bitte einen Namen vergeben', 'error');
    const saved = await run(() => save('alerts', draft), 'Alert gespeichert');
    if (saved) {
      setDirty(false);
      setDraft(saved);
      if (id === 'new') location.replace(`#/alerts/${saved.id}`);
    }
  };

  const testNow = async () => {
    let target = draft;
    if (dirty || !draft.id) {
      const saved = await run(() => save('alerts', draft));
      if (!saved) return;
      setDraft(saved);
      setDirty(false);
      target = saved;
      if (id === 'new') location.replace(`#/alerts/${saved.id}`);
    }
    run(() => api.post(`/api/alerts/${target.id}/fire`, { tierId: tier?.id }), 'Alert eingereiht');
  };

  const addTrack = () => {
    const firstLight = lights.find((l) => l.enabled && l.role === 'deco') ?? lights[0];
    const firstEffect = effects[0];
    if (!firstLight && groups.length === 0) return notify('Lege zuerst unter „Lichter“ ein Licht an', 'error');
    setTracks([
      ...tracks,
      {
        id: newId('tr'),
        target: firstLight ? { kind: 'light', lightId: firstLight.id } : { kind: 'group', groupId: groups[0].id },
        effect: firstEffect ? { type: 'own', effectId: firstEffect.id } : { type: 'eventColor', fallback: '#b794ff', brightness: 100 },
        offsetMs: 0,
      },
    ]);
  };

  return (
    <>
      <TopBar title={draft.name || 'Alert'} back="#/alerts">
        <button className="btn outlined" onClick={testNow}>
          <Icon name="play_arrow" />
          {tier ? `Testen (${tier.label})` : 'Testen'}
        </button>
        <button className="btn" onClick={doSave} disabled={!dirty && !!draft.id}>
          <Icon name="save" />
          Speichern
        </button>
      </TopBar>
      <div className="page">
        <div className="grid-2" style={{ alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
          <div className="list" style={{ gap: 16 }}>
            <section className="card">
              <h2>1 · Trigger</h2>
              <Field label="Name">
                <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
              </Field>
              <Field label="StreamElements-Event">
                <select
                  value={draft.trigger}
                  onChange={(e) => {
                    const trigger = e.target.value as EventType;
                    update({ trigger, mode: AMOUNT_TYPES.includes(trigger) ? draft.mode : 'single' });
                  }}
                >
                  {Object.entries(EVENT_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              {AMOUNT_TYPES.includes(draft.trigger) && (
                <Segmented
                  label="Betrag"
                  value={draft.mode}
                  onChange={(mode) => {
                    if (mode === 'tiers' && draft.tiers.length === 0) {
                      const t1 = { ...nextTier([], isMoney), tracks: draft.tracks };
                      update({ mode, tiers: [t1], conditions: { ...draft.conditions, amount: { mode: 'any' } } });
                      setTierId(t1.id);
                    } else update({ mode });
                  }}
                  options={[
                    { value: 'single', label: 'Ein Alert' },
                    { value: 'tiers', label: 'Stufen nach Betrag' },
                  ]}
                />
              )}
              {draft.mode === 'single' && AMOUNT_TYPES.includes(draft.trigger) && (
                <AmountEditor value={draft.conditions.amount} unit={unit} onChange={(amount) => update({ conditions: { ...draft.conditions, amount } })} />
              )}
              {draft.trigger === 'channelPoints' && (
                <RewardPicker
                  value={draft.conditions.reward}
                  onChange={(reward, cost) =>
                    update({
                      conditions: {
                        ...draft.conditions,
                        reward,
                        // Bei Auswahl einer Belohnung ohne Betragsbedingung nichts erzwingen
                        amount: cost !== undefined && draft.conditions.amount.mode !== 'any' ? { mode: 'exact', value: cost } : draft.conditions.amount,
                      },
                    })
                  }
                />
              )}
              <Field label="Nachricht enthält (optional)" hint={draft.trigger === 'chatMessage' ? 'z. B. „!farbe“ für einen Chat-Befehl' : undefined}>
                <input value={draft.conditions.textContains ?? ''} onChange={(e) => update({ conditions: { ...draft.conditions, textContains: e.target.value || undefined } })} />
              </Field>
              <div className="row">
                <Field label="Plattform" compact>
                  <select value={draft.conditions.provider ?? ''} onChange={(e) => update({ conditions: { ...draft.conditions, provider: e.target.value || undefined } })}>
                    <option value="">alle</option>
                    <option value="twitch">Twitch</option>
                    <option value="youtube">YouTube</option>
                    <option value="kick">Kick</option>
                  </select>
                </Field>
                {draft.trigger === 'subscriber' && (
                  <Field label="Sub-Stufe" compact>
                    <select value={draft.conditions.subTier ?? ''} onChange={(e) => update({ conditions: { ...draft.conditions, subTier: e.target.value || undefined } })}>
                      <option value="">alle</option>
                      <option value="1000">Tier 1</option>
                      <option value="2000">Tier 2</option>
                      <option value="3000">Tier 3</option>
                      <option value="prime">Prime</option>
                    </select>
                  </Field>
                )}
              </div>
              <Switch checked={draft.conditions.allowTest} onChange={(v) => update({ conditions: { ...draft.conditions, allowTest: v } })} label="Testevents zulassen" />
            </section>

            {draft.mode === 'tiers' && (
              <section className="card">
                <div className="row">
                  <h2 className="grow">2 · Stufen</h2>
                  {problems.length === 0 ? (
                    <span className="small" style={{ color: 'var(--on-success-container)', display: 'flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="check_circle" style={{ fontSize: 16 }} />
                      Keine Lücken
                    </span>
                  ) : (
                    <span className="small" style={{ color: 'var(--error)' }}>
                      {problems.length} Hinweis{problems.length > 1 ? 'e' : ''}
                    </span>
                  )}
                </div>
                {problems.map((p) => (
                  <span key={p} className="small" style={{ color: 'var(--error)' }}>
                    {p}
                  </span>
                ))}
                <div className="list" style={{ gap: 8 }}>
                  {draft.tiers.map((t) => (
                    <div
                      key={t.id}
                      className="list-item"
                      style={{ padding: 12, background: t.id === tier?.id ? 'var(--surface-high)' : undefined, borderColor: t.id === tier?.id ? 'var(--primary)' : undefined }}
                    >
                      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="row">
                          <input
                            aria-label="Name der Stufe"
                            value={t.label}
                            onChange={(e) => setTier({ ...t, label: e.target.value })}
                            style={{ background: 'none', border: 0, borderBottom: '1px solid var(--outline-variant)', fontWeight: 600, padding: '4px 0', minWidth: 0, flex: 1 }}
                          />
                          <span className="tag">{describeAmount(t.amount, unit)}</span>
                          <span className="tag">{t.tracks.length} Spuren</span>
                        </div>
                        <AmountEditor value={t.amount} unit={unit} onChange={(amount) => setTier({ ...t, amount })} />
                      </div>
                      <div className="row" style={{ gap: 4 }}>
                        <button className={`chip ${t.id === tier?.id ? 'selected' : ''}`} onClick={() => setTierId(t.id)}>
                          <Icon name="tune" />
                          Spuren
                        </button>
                        <button className="icon-btn" aria-label="Stufe löschen" onClick={() => update({ tiers: draft.tiers.filter((x) => x.id !== t.id) })}>
                          <Icon name="delete" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  className="btn text"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    const t = nextTier(draft.tiers, isMoney);
                    update({ tiers: [...draft.tiers, t] });
                    setTierId(t.id);
                  }}
                >
                  <Icon name="add" />
                  Stufe hinzufügen
                </button>
                <p className="small muted" style={{ margin: 0 }}>
                  Ein exakter Betrag (z. B. 4,20 €) gewinnt immer gegen einen Bereich. Die letzte Stufe am besten als „ab“ anlegen.
                </p>
              </section>
            )}

            <section className="card">
              <h2>4 · Optionen</h2>
              <Field label="Danach">
                <select value={draft.after} onChange={(e) => update({ after: e.target.value as Alert['after'] })}>
                  <option value="restore">Zurück in den Ruhezustand des Lichts</option>
                  <option value="hold">Letzten Zustand halten</option>
                </select>
              </Field>
              <div className="row">
                <Field label="Cooldown (Sekunden)" compact>
                  <NumberInput value={draft.cooldownMs / 1000} onChange={(v) => update({ cooldownMs: Math.max(0, v) * 1000 })} style={{ width: 120 }} />
                </Field>
                <Field label="Wenn mehrere Alerts passen" compact>
                  <select value={draft.overlap} onChange={(e) => update({ overlap: e.target.value as Alert['overlap'] })}>
                    <option value="exclusive">Spezifischster gewinnt</option>
                    <option value="additive">Immer zusätzlich ausführen</option>
                  </select>
                </Field>
              </div>
              <Field label="Auslösung" hint={`Global eingestellt: ${settings.triggerMode === 'auto' ? 'automatisch' : 'manuell'} (umschaltbar oben rechts).`}>
                <select value={draft.triggerMode ?? 'inherit'} onChange={(e) => update({ triggerMode: e.target.value as Alert['triggerMode'] })}>
                  <option value="inherit">Wie global eingestellt</option>
                  <option value="auto">Immer automatisch</option>
                  <option value="manual">Immer nach manueller Freigabe</option>
                </select>
              </Field>
              <Switch checked={draft.enabled} onChange={(v) => update({ enabled: v })} label="Alert aktiv" />
            </section>
          </div>

          <section className="card" style={{ minWidth: 0 }}>
            <div className="row">
              <h2 className="grow">3 · Licht-Spuren{tier ? ` · ${tier.label}` : ''}</h2>
              <span className="mono small muted">Dauer {(total / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s</span>
            </div>
            {draft.mode === 'tiers' && !tier && <div className="empty">Lege zuerst eine Stufe an.</div>}
            {(draft.mode === 'single' || tier) && (
              <>
                {tracks.length > 0 && (
                  <div className="list" style={{ gap: 6 }}>
                    <div className="timeline-scale" style={{ paddingLeft: 168 }}>
                      {[0, 0.25, 0.5, 0.75].map((f) => (
                        <span key={f} style={{ flex: 1 }}>
                          {((total * f) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s
                        </span>
                      ))}
                      <span>{(total / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s</span>
                    </div>
                    {tracks.map((t, i) => {
                      const left = (t.offsetMs / total) * 100;
                      const width = Math.max(4, (trackDuration(t) / total) * 100);
                      const colors = [
                        ['var(--primary)', 'var(--on-primary)'],
                        ['var(--secondary-container)', 'var(--on-secondary-container)'],
                        ['var(--success-container)', 'var(--on-success-container)'],
                      ][i % 3];
                      return (
                        <div key={t.id} className="row" style={{ flexWrap: 'nowrap' }}>
                          <span className="small" style={{ width: 156, flex: '0 0 156px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label.target(t)}>
                            {label.target(t)}
                          </span>
                          <div className="timeline-row">
                            <div className="timeline-bar" style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%`, background: colors[0], color: colors[1] }}>
                              {label.effect(t)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="list">
                  {tracks.map((t) => (
                    <TrackEditor
                      key={t.id}
                      track={t}
                      byConnector={byConnector}
                      onChange={(nt) => setTracks(tracks.map((x) => (x.id === t.id ? nt : x)))}
                      onDelete={() => setTracks(tracks.filter((x) => x.id !== t.id))}
                    />
                  ))}
                </div>
                {tracks.length === 0 && <div className="empty">Noch keine Spuren. Füge Lichter hinzu und wähle je einen Effekt.</div>}
                <button className="btn tonal" style={{ alignSelf: 'flex-start' }} onClick={addTrack}>
                  <Icon name="add" />
                  Licht hinzufügen
                </button>
                <p className="small muted" style={{ margin: 0 }}>
                  Bildlichter (Rolle „Bildlicht“) sind gesperrt, solange die Sperre in den Einstellungen aktiv ist ({settings.safety.lockSceneLights ? 'aktiv' : 'aus'}).
                </p>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function TrackEditor({
    track,
    byConnector,
    onChange,
    onDelete,
  }: {
    track: Track;
    byConnector: Map<ConnectorType, Light[]>;
    onChange: (t: Track) => void;
    onDelete: () => void;
  }) {
    const { lights, groups, effects, settings } = useData();
    const targetValue = track.target.kind === 'light' ? `l:${track.target.lightId}` : `g:${track.target.groupId}`;
    const light = track.target.kind === 'light' ? lights.find((l) => l.id === (track.target as { lightId: string }).lightId) : undefined;
    const effectValue =
      track.effect.type === 'own' ? `o:${track.effect.effectId}` : track.effect.type === 'native' ? `n:${track.effect.nativeId}` : 'c:';
    return (
      <div className="list-item" style={{ padding: 12, alignItems: 'flex-end' }}>
        <Field label="Licht / Gruppe" compact>
          <select
            value={targetValue}
            onChange={(e) => {
              const v = e.target.value;
              const target: Track['target'] = v.startsWith('l:') ? { kind: 'light', lightId: v.slice(2) } : { kind: 'group', groupId: v.slice(2) };
              const effect = track.effect.type === 'native' ? (effects[0] ? { type: 'own' as const, effectId: effects[0].id } : track.effect) : track.effect;
              onChange({ ...track, target, effect });
            }}
          >
            {[...byConnector.entries()].map(([c, ls]) => (
              <optgroup key={c} label={CONNECTOR_LABELS[c]}>
                {ls.map((l) => (
                  <option key={l.id} value={`l:${l.id}`} disabled={l.role === 'scene' && settings.safety.lockSceneLights}>
                    {l.name}
                    {l.role === 'scene' ? ' · Bildlicht' : ''}
                    {!l.enabled ? ' · aus' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
            {groups.length > 0 && (
              <optgroup label="Gruppen">
                {groups.map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Effekt" compact>
          <select
            value={effectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('o:')) onChange({ ...track, effect: { type: 'own', effectId: v.slice(2) } });
              else if (v.startsWith('n:')) onChange({ ...track, effect: { type: 'native', nativeId: v.slice(2) } });
              else onChange({ ...track, effect: { type: 'eventColor', fallback: '#b794ff', brightness: 100 } });
            }}
          >
            <optgroup label="Eigene Effekte">
              {effects.map((e) => (
                <option key={e.id} value={`o:${e.id}`}>
                  {e.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Interaktiv">
              <option value="c:">Farbe aus Nachricht / Kanalpunkte</option>
            </optgroup>
            {light && light.nativeEffects.length > 0 && (
              <optgroup label={`Hersteller · ${CONNECTOR_LABELS[light.connector]}`}>
                {light.nativeEffects.map((n) => (
                  <option key={n.id} value={`n:${n.id}`}>
                    {n.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        {track.effect.type === 'eventColor' && (
          <Field label="Ersatzfarbe" compact>
            <input
              type="color"
              value={track.effect.fallback}
              onChange={(e) => onChange({ ...track, effect: { ...(track.effect as { type: 'eventColor'; fallback: string; brightness: number }), fallback: e.target.value } })}
            />
          </Field>
        )}
        <Field label="Start (s)" compact>
          <NumberInput value={track.offsetMs / 1000} onChange={(v) => onChange({ ...track, offsetMs: Math.max(0, Math.round(v * 1000)) })} style={{ width: 80 }} />
        </Field>
        <Field label={`Dauer (s)${track.effect.type === 'own' ? ' leer = Effekt' : ''}`} compact>
          <NumberInput
            value={track.durationMs ? track.durationMs / 1000 : undefined}
            onChange={(v) => onChange({ ...track, durationMs: v > 0 ? Math.round(v * 1000) : undefined })}
            style={{ width: 90 }}
            placeholder={track.effect.type === 'own' ? 'auto' : track.effect.type === 'eventColor' ? '8' : '5'}
          />
        </Field>
        <button className="icon-btn" aria-label="Spur entfernen" onClick={onDelete}>
          <Icon name="delete" />
        </button>
      </div>
    );
  }
