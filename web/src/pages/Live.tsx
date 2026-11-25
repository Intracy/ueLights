import { useEffect, useState } from 'react';
import { EVENT_TYPE_LABELS, EVENT_AMOUNT_UNIT, type EventLogEntry, type EventType, type NormalizedEvent } from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Field, Icon, LedStrip, NumberInput, TopBar, formatAgo } from '../ui';

export const EVENT_ICONS: Record<EventType, string> = {
  tip: 'euro',
  cheer: 'diamond',
  subscriber: 'star',
  giftSub: 'redeem',
  raid: 'groups',
  follow: 'favorite',
  channelPoints: 'palette',
  chatMessage: 'chat',
  superchat: 'paid',
  merch: 'shopping_bag',
  hypetrain: 'train',
  other: 'bolt',
};

const QUICK: Array<{ label: string; ev: Partial<NormalizedEvent> & { type: EventType } }> = [
  { label: 'Spende 5 €', ev: { type: 'tip', amount: 5 } },
  { label: 'Spende 10 €', ev: { type: 'tip', amount: 10 } },
  { label: 'Spende 50 €', ev: { type: 'tip', amount: 50 } },
  { label: '500 Bits', ev: { type: 'cheer', amount: 500 } },
  { label: 'Sub', ev: { type: 'subscriber', amount: 1, subTier: '1000' } },
  { label: '5 Gift-Subs', ev: { type: 'giftSub', amount: 5 } },
  { label: 'Raid 20', ev: { type: 'raid', amount: 20 } },
  { label: 'Kanalpunkte „blau“', ev: { type: 'channelPoints', reward: 'Farbe wählen', message: 'blau' } },
  { label: 'Chat „!farbe rot“', ev: { type: 'chatMessage', message: '!farbe rot' } },
];

function summary(ev: NormalizedEvent): string {
  const unit = EVENT_AMOUNT_UNIT[ev.type];
  const amount =
    ev.amount !== undefined
      ? ev.type === 'tip' || ev.type === 'superchat'
        ? `${ev.amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
        : `${ev.amount.toLocaleString('de-DE')} ${unit ?? ''}`
      : '';
  return `${EVENT_TYPE_LABELS[ev.type]}${amount ? ` · ${amount}` : ''}`;
}

function statusText(e: EventLogEntry): { text: string; cls: string } {
  const o = e.outcome;
  if (o.status === 'skipped') return { text: o.reason, cls: 'muted' };
  const names = e.alertNames.join(' + ') + (o.tierLabel ? ` · ${o.tierLabel}` : '');
  if (o.status === 'queued') return { text: `${names} · wartet`, cls: '' };
  if (o.status === 'playing') return { text: `${names} · läuft`, cls: '' };
  return { text: `${names} · fertig`, cls: 'muted' };
}

export function LivePage() {
  const { live, log, lights, virtualFrames, run } = useData();
  const [now, setNow] = useState(Date.now());
  const [custom, setCustom] = useState<{ type: EventType; amount?: number; message: string; user: string; reward: string }>({
    type: 'tip',
    amount: 5,
    message: '',
    user: 'testzuschauer',
    reward: '',
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const np = live.nowPlaying;
  const progress = np ? Math.min(100, ((now - np.startedAt) / Math.max(1, np.durationMs)) * 100) : 0;
  const virtual = lights.filter((l) => l.connector === 'virtual' && l.enabled);
  const fire = (ev: Partial<NormalizedEvent> & { type: EventType }) => run(() => api.post('/api/test-event', ev));

  return (
    <>
      <TopBar title="Live" />
      <div className="page">
        {np ? (
          <section className="now-playing" aria-label="Läuft gerade">
            <div className="row">
              <Icon name="graphic_eq" />
              <strong className="grow">
                Läuft: {np.alertNames.join(' + ')}
                {np.tierLabel ? ` · ${np.tierLabel}` : ''}
              </strong>
              <span className="mono small">noch {Math.max(0, Math.ceil((np.durationMs - (now - np.startedAt)) / 1000))} s</span>
            </div>
            <div className="progress">
              <div style={{ width: `${progress}%` }} />
            </div>
            <div className="row small">
              <span className="mono">{np.eventSummary}</span>
              {np.lights.map((l) => (
                <span key={l} className="tag" style={{ background: 'rgba(0,0,0,.3)', color: 'inherit', borderColor: 'transparent' }}>
                  {l}
                </span>
              ))}
            </div>
            {live.queueLength > 0 && <span className="small">{live.queueLength} weitere in der Warteschlange</span>}
          </section>
        ) : (
          <section className="card" aria-label="Status">
            <div className="row">
              <Icon name={live.paused ? 'pause_circle' : 'sensors'} style={{ color: live.paused ? 'var(--error)' : 'var(--secondary)' }} />
              <span className="grow">{live.paused ? 'Alerts sind pausiert – Events werden nur protokolliert.' : 'Bereit. Warte auf Events von StreamElements.'}</span>
              <span className="mono small muted">Warteschlange {live.queueLength}</span>
            </div>
          </section>
        )}

        {virtual.length > 0 && (
          <section className="card">
            <span className="label">Virtuelle Lichter</span>
            {virtual.map((l) => (
              <div key={l.id} className="list" style={{ gap: 4 }}>
                <span className="small">{l.name}</span>
                <LedStrip leds={virtualFrames[l.id] ?? new Array(l.config.ledCount ?? 60).fill('#000000')} />
              </div>
            ))}
          </section>
        )}

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="card" style={{ gap: 8 }}>
            <div className="row">
              <h2 className="grow">Eingegangen</h2>
              <span className="label">{log.length} Events</span>
            </div>
            {log.length === 0 && (
              <div className="empty">
                <Icon name="inbox" />
                Noch keine Events. Löse rechts ein Testevent aus.
              </div>
            )}
            <div className="list" style={{ gap: 0 }}>
              {log.slice(0, 80).map((e) => {
                const st = statusText(e);
                const active = e.outcome.status === 'playing';
                return (
                  <div key={e.event.id + e.receivedAt} className="row" style={{ padding: '10px 4px', borderBottom: '1px solid var(--outline-variant)', flexWrap: 'nowrap' }}>
                    <span className={`avatar ${e.outcome.status === 'skipped' ? 'grey' : active ? '' : 'cyan'}`}>
                      <Icon name={EVENT_ICONS[e.event.type]} />
                    </span>
                    <div className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                      <span>
                        {summary(e.event)}
                        {e.event.isTest && <span className="tag" style={{ marginLeft: 8 }}>TEST</span>}
                      </span>
                      <span className={`small ${st.cls}`}>
                        {e.event.user ? `${e.event.user} · ` : ''}
                        {st.text}
                      </span>
                      {e.event.message && <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>„{e.event.message}“</span>}
                    </div>
                    <span className="mono small muted">{formatAgo(e.receivedAt)}</span>
                    <button className="icon-btn" aria-label="Erneut abspielen" title="Erneut abspielen" onClick={() => run(() => api.post(`/api/events/${encodeURIComponent(e.event.id)}/replay`), 'Erneut eingereiht')}>
                      <Icon name="replay" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <h2>Testevent senden</h2>
            <p className="small muted" style={{ margin: 0 }}>
              Testevents laufen durch dieselbe Logik wie echte Events. Alerts reagieren nur, wenn „Testevents zulassen“ aktiv ist.
            </p>
            <div className="row" style={{ gap: 8 }}>
              {QUICK.map((q) => (
                <button key={q.label} className="chip" onClick={() => fire(q.ev)}>
                  <Icon name={EVENT_ICONS[q.ev.type]} />
                  {q.label}
                </button>
              ))}
            </div>
            <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <Field label="Event" compact>
                <select value={custom.type} onChange={(e) => setCustom({ ...custom, type: e.target.value as EventType })}>
                  {Object.entries(EVENT_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Betrag${EVENT_AMOUNT_UNIT[custom.type] ? ` (${EVENT_AMOUNT_UNIT[custom.type]})` : ''}`} compact>
                <NumberInput value={custom.amount} onChange={(v) => setCustom({ ...custom, amount: v })} />
              </Field>
              <Field label="Name" compact>
                <input value={custom.user} onChange={(e) => setCustom({ ...custom, user: e.target.value })} />
              </Field>
              <Field label="Nachricht" compact>
                <input value={custom.message} onChange={(e) => setCustom({ ...custom, message: e.target.value })} />
              </Field>
              <Field label="Kanalpunkte-Belohnung" compact>
                <input value={custom.reward} onChange={(e) => setCustom({ ...custom, reward: e.target.value })} />
              </Field>
            </div>
            <button
              className="btn tonal"
              style={{ alignSelf: 'flex-start' }}
              onClick={() =>
                fire({
                  type: custom.type,
                  amount: custom.amount,
                  user: custom.user || undefined,
                  message: custom.message || undefined,
                  reward: custom.reward || undefined,
                })
              }
            >
              <Icon name="science" />
              Senden
            </button>
          </section>
        </div>
      </div>
    </>
  );
}
