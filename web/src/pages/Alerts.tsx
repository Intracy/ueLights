import { useState } from 'react';
import { EVENT_AMOUNT_UNIT, EVENT_TYPE_LABELS, describeAmount, newId, type Alert, type EventType, type Track } from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Icon, TopBar, confirmDelete } from '../ui';
import { EVENT_ICONS } from './Live';

export function useTrackLabel() {
  const { lights, groups, effects } = useData();
  return {
    target: (t: Track) =>
      t.target.kind === 'light'
        ? lights.find((l) => l.id === (t.target as { lightId: string }).lightId)?.name ?? 'Licht fehlt'
        : `Gruppe: ${groups.find((g) => g.id === (t.target as { groupId: string }).groupId)?.name ?? 'fehlt'}`,
    effect: (t: Track) => {
      if (t.effect.type === 'own') {
        const id = t.effect.effectId;
        return effects.find((e) => e.id === id)?.name ?? 'Effekt fehlt';
      }
      if (t.effect.type === 'eventColor') return 'Farbe aus Nachricht';
      const nativeId = t.effect.nativeId;
      for (const l of lights) {
        const n = l.nativeEffects.find((x) => x.id === nativeId);
        if (n) return n.name;
      }
      return 'Hersteller-Effekt';
    },
  };
}

export function alertSummary(a: Alert): string {
  const unit = EVENT_AMOUNT_UNIT[a.trigger] ?? '';
  const parts = [EVENT_TYPE_LABELS[a.trigger]];
  if (a.mode === 'tiers') parts.push(`${a.tiers.length} Stufen: ${a.tiers.map((t) => describeAmount(t.amount, unit)).join(', ')}`);
  else if (a.conditions.amount.mode !== 'any') parts.push(describeAmount(a.conditions.amount, unit));
  if (a.conditions.reward) parts.push(`„${a.conditions.reward}“`);
  if (a.conditions.textContains) parts.push(`enthält „${a.conditions.textContains}“`);
  if (a.overlap === 'additive') parts.push('zusätzlich');
  return parts.join(' · ');
}

export function AlertsPage() {
  const { alerts, save, remove, reorder, run } = useData();
  const label = useTrackLabel();
  const [filter, setFilter] = useState<EventType | 'all'>('all');
  const triggers = [...new Set(alerts.map((a) => a.trigger))];
  const shown = alerts.filter((a) => filter === 'all' || a.trigger === filter);

  const move = (a: Alert, dir: -1 | 1) => {
    const i = alerts.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (j < 0 || j >= alerts.length) return;
    const next = alerts.slice();
    [next[i], next[j]] = [next[j], next[i]];
    run(() => reorder('alerts', next));
  };

  const duplicate = (a: Alert) => {
    const copy: Alert = structuredClone(a);
    copy.id = newId('al');
    copy.name = `${a.name} (Kopie)`;
    copy.tiers = copy.tiers.map((t) => ({ ...t, id: newId('tier'), tracks: t.tracks.map((tr) => ({ ...tr, id: newId('tr') })) }));
    copy.tracks = copy.tracks.map((tr) => ({ ...tr, id: newId('tr') }));
    run(() => save('alerts', copy), 'Alert dupliziert');
  };

  return (
    <>
      <TopBar title="Alerts" />
      <div className="page">
        <div className="row" role="group" aria-label="Nach Trigger filtern" style={{ gap: 8 }}>
          <button className={`chip ${filter === 'all' ? 'selected' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            {filter === 'all' && <Icon name="check" />}Alle
          </button>
          {triggers.map((t) => (
            <button key={t} className={`chip ${filter === t ? 'selected' : ''}`} aria-pressed={filter === t} onClick={() => setFilter(t)}>
              {filter === t && <Icon name="check" />}
              {EVENT_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {alerts.length} Alerts · Reihenfolge = Priorität bei gleicher Genauigkeit
        </p>

        {alerts.length === 0 && (
          <div className="empty">
            <Icon name="notifications_active" style={{ fontSize: 40, color: 'var(--primary)' }} />
            <span>Noch keine Alerts. Lege einen an, z. B. Spenden-Stufen für 5 €, 10 € und 50 €.</span>
            <a className="btn" href="#/alerts/new">
              <Icon name="add" />
              Neuer Alert
            </a>
          </div>
        )}

        <div className="list">
          {shown.map((a) => {
            const tracks = a.mode === 'tiers' ? a.tiers.flatMap((t) => t.tracks) : a.tracks;
            const targets = [...new Set(tracks.map(label.target))];
            const idx = alerts.findIndex((x) => x.id === a.id);
            return (
              <div key={a.id} className={`list-item ${a.enabled ? '' : 'off'}`}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <button className="icon-btn" style={{ height: 24 }} aria-label="Nach oben" disabled={idx === 0} onClick={() => move(a, -1)}>
                    <Icon name="keyboard_arrow_up" />
                  </button>
                  <button className="icon-btn" style={{ height: 24 }} aria-label="Nach unten" disabled={idx === alerts.length - 1} onClick={() => move(a, 1)}>
                    <Icon name="keyboard_arrow_down" />
                  </button>
                </div>
                <span className={`avatar ${a.enabled ? '' : 'grey'}`}>
                  <Icon name={EVENT_ICONS[a.trigger]} />
                </span>
                <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 6, flexBasis: 260 }}>
                  <a href={`#/alerts/${a.id}`} style={{ color: 'var(--on-surface)', textDecoration: 'none', fontSize: 16, fontWeight: 500 }}>
                    {a.name}
                  </a>
                  <span className="small muted">{alertSummary(a)}</span>
                  <span className="row" style={{ gap: 6 }}>
                    {a.triggerMode === 'manual' && (
                      <span className="tag" style={{ color: 'var(--primary)' }}>
                        <Icon name="touch_app" style={{ fontSize: 14 }} />
                        manuell
                      </span>
                    )}
                    {a.triggerMode === 'auto' && (
                      <span className="tag" style={{ color: 'var(--secondary)' }}>
                        <Icon name="bolt" style={{ fontSize: 14 }} />
                        immer automatisch
                      </span>
                    )}
                    {targets.length === 0 && <span className="tag" style={{ color: 'var(--error)' }}>keine Lichter</span>}
                    {targets.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
                <button className="chip" onClick={() => run(() => api.post(`/api/alerts/${a.id}/fire`, {}), 'Alert eingereiht')}>
                  <Icon name="play_arrow" />
                  Testen
                </button>
                <label className="switch">
                  <input type="checkbox" role="switch" checked={a.enabled} onChange={(e) => run(() => save('alerts', { ...a, enabled: e.target.checked }))} />
                  <span className="sr-only">Aktiv</span>
                </label>
                <button className="icon-btn" aria-label="Duplizieren" title="Duplizieren" onClick={() => duplicate(a)}>
                  <Icon name="content_copy" />
                </button>
                <button className="icon-btn" aria-label="Löschen" title="Löschen" onClick={() => confirmDelete(a.name) && run(() => remove('alerts', a.id), 'Alert gelöscht')}>
                  <Icon name="delete" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <a className="fab" href="#/alerts/new">
        <Icon name="add" />
        Neuer Alert
      </a>
    </>
  );
}
