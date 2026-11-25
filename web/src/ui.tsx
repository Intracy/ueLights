import { useEffect, useRef, useState, type ReactNode } from 'react';
import { renderEffect, rgbToHex, type ConnectionStatus, type Effect } from '@uelights/shared';
import { api } from './api';
import { useData } from './data';

export function Icon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  return (
    <span className={`ms ${className ?? ''}`} aria-hidden="true" style={style}>
      {name}
    </span>
  );
}

export function Field({ label, hint, children, compact }: { label: string; hint?: ReactNode; children: ReactNode; compact?: boolean }) {
  return (
    <label className={`field ${compact ? 'compact' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  ...rest
}: { value: number | undefined; onChange: (v: number) => void; step?: number; min?: number; max?: number } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const [text, setText] = useState(value === undefined ? '' : String(value).replace('.', ','));
  useEffect(() => {
    const parsed = Number(text.replace(',', '.'));
    if (value !== parsed) setText(value === undefined || Number.isNaN(value) ? '' : String(value).replace('.', ','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      {...rest}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.'));
        if (e.target.value.trim() !== '' && Number.isFinite(n)) {
          let v = n;
          if (min !== undefined) v = Math.max(min, v);
          if (max !== undefined) v = Math.min(max, v);
          onChange(v);
        }
      }}
      data-step={step}
    />
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {value === o.value && <Icon name="check" style={{ fontSize: 18 }} />}
          {o.icon && value !== o.value && <Icon name={o.icon} style={{ fontSize: 18 }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  title,
  children,
  actions,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row">
          <h2 className="grow">{title}</h2>
          <button className="icon-btn" aria-label="Schließen" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function confirmDelete(what: string): boolean {
  return window.confirm(`„${what}“ wirklich löschen? Das lässt sich nicht rückgängig machen.`);
}

export function ConnectionChip({ c }: { c: ConnectionStatus }) {
  if (c.state === 'disabled') return null;
  const cls = c.state === 'ok' ? 'ok' : c.state === 'error' ? 'err' : 'wait';
  return (
    <span className={`chip ${cls}`} title={c.detail}>
      <span className="dot" />
      {c.label}
    </span>
  );
}

export function TopBar({ title, children, back }: { title: string; children?: ReactNode; back?: string }) {
  const { live, run } = useData();
  return (
    <header className="topbar">
      {back && (
        <a href={back} className="icon-btn" aria-label="Zurück">
          <Icon name="arrow_back" />
        </a>
      )}
      <h1>{title}</h1>
      {children}
      <div className="row hide-compact">
        {live.connections.map((c) => (
          <ConnectionChip key={c.id} c={c} />
        ))}
      </div>
      <button
        className={`chip ${live.paused ? 'selected' : ''}`}
        onClick={() => run(() => api.post('/api/pause', { paused: !live.paused }))}
        aria-pressed={live.paused}
      >
        <Icon name={live.paused ? 'play_circle' : 'pause_circle'} />
        <span className="hide-compact">{live.paused ? 'Fortsetzen' : 'Pausieren'}</span>
      </button>
      <button className="btn danger" onClick={() => run(() => api.post('/api/stop'))} aria-label="Alles stoppen">
        <Icon name="stop_circle" />
        <span className="hide-compact">Alles stoppen</span>
      </button>
    </header>
  );
}

/** Animierte LED-Vorschau eines Effekts (rechnet mit derselben Logik wie der Server). */
export function EffectPreview({ effect, leds = 48, amount, maxFlashHz }: { effect: Effect; leds?: number; amount?: number; maxFlashHz: number }) {
  const [frame, setFrame] = useState<string[]>([]);
  const start = useRef(performance.now());
  useEffect(() => {
    start.current = performance.now();
    let raf = 0;
    const ratio =
      effect.amountMapping && amount !== undefined
        ? Math.max(0, Math.min(1, (amount - effect.amountMapping.min) / Math.max(0.0001, effect.amountMapping.max - effect.amountMapping.min)))
        : undefined;
    const loop = () => {
      const dur = effect.durationMs + 800;
      const t = (performance.now() - start.current) % dur;
      const f = renderEffect(effect, t, { ledCount: leds, maxFlashHz, amountRatio: ratio });
      setFrame(f.leds.map(rgbToHex));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [effect, leds, amount, maxFlashHz]);
  return <LedStrip leds={frame} />;
}

export function LedStrip({ leds }: { leds: string[] }) {
  return (
    <div className="led-strip" aria-hidden="true">
      {leds.map((c, i) => (
        <span key={i} style={{ background: c, boxShadow: c !== '#000000' ? `0 0 6px ${c}` : undefined }} />
      ))}
    </div>
  );
}

export function useHashRoute(): string[] {
  const get = () => (location.hash.replace(/^#\/?/, '') || 'live').split('/');
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function formatAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return 'jetzt';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('de-DE');
}
