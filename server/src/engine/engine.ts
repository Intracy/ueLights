import {
  EVENT_TYPE_LABELS,
  pickAlerts,
  type Alert,
  type EventLogEntry,
  type EventOutcome,
  type NormalizedEvent,
  type NowPlaying,
  type Settings,
  type Tier,
} from '@uelights/shared';
import type { Player } from './player.js';

interface Job {
  event: NormalizedEvent;
  alerts: Array<{ alert: Alert; tier?: Tier }>;
  /** Manuell ausgelöst: Bedingungen/Cooldown/Pause ignorieren */
  forced: boolean;
}

export interface EngineHooks {
  onLog: (entry: EventLogEntry) => void;
  onUpdate: (eventId: string, outcome: EventOutcome) => void;
  onState: () => void;
  warn: (msg: string) => void;
}

function inQuietHours(q: Settings['safety']['quietHours'], now = new Date()): boolean {
  if (!q.enabled) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMin(q.from);
  const to = toMin(q.to);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

export function summarizeEvent(ev: NormalizedEvent): string {
  const label = EVENT_TYPE_LABELS[ev.type];
  const amount =
    ev.amount !== undefined
      ? ev.type === 'tip' || ev.type === 'superchat'
        ? ` ${ev.amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ev.currency && ev.originalAmount !== ev.amount ? '€' : ev.currency ?? '€'}`
        : ` ${ev.amount}`
      : '';
  return `${label}${amount}${ev.user ? ` · ${ev.user}` : ''}`;
}

/**
 * Nimmt normalisierte Events entgegen, wählt passende Alerts und spielt sie nacheinander ab.
 */
export class AlertEngine {
  private queue: Job[] = [];
  private running: { job: Job; ctrl: AbortController } | null = null;
  private lastRun = new Map<string, number>();
  /** Im manuellen Modus: Events, die auf Freigabe warten (Reihenfolge = Eingang) */
  private pending = new Map<string, Job>();
  nowPlaying: NowPlaying | null = null;

  constructor(
    private player: Player,
    private getAlerts: () => Alert[],
    private getSettings: () => Settings,
    private hooks: EngineHooks,
  ) {}

  get queueLength(): number {
    return this.queue.length;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Event aus StreamElements oder Test verarbeiten. */
  handle(ev: NormalizedEvent, dropReason?: string, opts: { forcePlay?: boolean } = {}): void {
    const settings = this.getSettings();
    const receivedAt = new Date().toISOString();
    const skip = (reason: string) => {
      this.hooks.onLog({ event: ev, outcome: { status: 'skipped', reason }, alertNames: [], receivedAt });
    };

    if (dropReason) return skip(dropReason);
    const age = Date.now() - Date.parse(ev.ts);
    if (!ev.isTest && ev.source === 'streamelements' && Number.isFinite(age) && age > settings.safety.staleEventSec * 1000) {
      return skip(`Zu alt (${Math.round(age / 1000)} s) – nur protokolliert`);
    }
    if (settings.safety.paused) return skip('Alerts pausiert');
    if (inQuietHours(settings.safety.quietHours)) return skip('Ruhezeit');

    const matches = pickAlerts(this.getAlerts(), ev).filter((m) => {
      const last = this.lastRun.get(m.alert.id) ?? 0;
      return Date.now() - last >= m.alert.cooldownMs;
    });
    if (matches.length === 0) return skip('Kein passender Alert');
    for (const m of matches) this.lastRun.set(m.alert.id, Date.now());

    const tierLabel = matches.find((m) => m.tier)?.tier?.label;
    const isManual = (a: Alert) => {
      const mode = a.triggerMode && a.triggerMode !== 'inherit' ? a.triggerMode : settings.triggerMode;
      return mode === 'manual';
    };
    const autoMatches = opts.forcePlay ? matches : matches.filter((m) => !isManual(m.alert));
    const manualMatches = opts.forcePlay ? [] : matches.filter((m) => isManual(m.alert));

    // Manuelle Alerts: auf Freigabe im Live-Feed warten
    if (manualMatches.length && !autoMatches.length) {
      for (const m of manualMatches) this.lastRun.delete(m.alert.id); // Cooldown erst bei Freigabe
      this.pending.set(ev.id, { event: ev, alerts: manualMatches.map((m) => ({ alert: m.alert, tier: m.tier })), forced: false });
      while (this.pending.size > 50) this.pending.delete(this.pending.keys().next().value as string);
      this.hooks.onLog({
        event: ev,
        outcome: { status: 'pending', alertIds: manualMatches.map((m) => m.alert.id), tierLabel },
        alertNames: manualMatches.map((m) => m.alert.name),
        receivedAt,
      });
      this.hooks.onState();
      return;
    }
    if (manualMatches.length) {
      // Gemischt: automatische laufen sofort, manuelle warten separat
      for (const m of manualMatches) this.lastRun.delete(m.alert.id);
      const pendingEv = { ...ev, id: `${ev.id}#manuell` };
      this.pending.set(pendingEv.id, { event: pendingEv, alerts: manualMatches.map((m) => ({ alert: m.alert, tier: m.tier })), forced: false });
      this.hooks.onLog({
        event: pendingEv,
        outcome: { status: 'pending', alertIds: manualMatches.map((m) => m.alert.id), tierLabel },
        alertNames: manualMatches.map((m) => m.alert.name),
        receivedAt,
      });
    }

    if (this.queue.length >= settings.safety.queueMax) return skip('Warteschlange voll');

    const job: Job = { event: ev, alerts: autoMatches.map((m) => ({ alert: m.alert, tier: m.tier })), forced: false };
    this.hooks.onLog({
      event: ev,
      outcome: { status: 'queued', alertIds: autoMatches.map((m) => m.alert.id), tierLabel },
      alertNames: autoMatches.map((m) => m.alert.name),
      receivedAt,
    });
    this.enqueue(job);
  }

  /** Wartendes Event freigeben (manueller Modus). */
  release(eventId: string): boolean {
    const job = this.pending.get(eventId);
    if (!job) return false;
    this.pending.delete(eventId);
    for (const a of job.alerts) this.lastRun.set(a.alert.id, Date.now());
    const tierLabel = job.alerts.find((a) => a.tier)?.tier?.label;
    this.hooks.onUpdate(eventId, { status: 'queued', alertIds: job.alerts.map((a) => a.alert.id), tierLabel });
    this.enqueue(job);
    return true;
  }

  /** Wartendes Event verwerfen. */
  dismiss(eventId: string): boolean {
    if (!this.pending.delete(eventId)) return false;
    this.hooks.onUpdate(eventId, { status: 'skipped', reason: 'Verworfen' });
    this.hooks.onState();
    return true;
  }

  releaseAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.release(id);
    return ids.length;
  }

  dismissAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.dismiss(id);
    return ids.length;
  }

  /** Alert direkt auslösen (Test-Button), optional eine bestimmte Stufe. */
  fire(alert: Alert, tier: Tier | undefined, ev: NormalizedEvent): void {
    const job: Job = { event: ev, alerts: [{ alert, tier }], forced: true };
    this.hooks.onLog({
      event: ev,
      outcome: { status: 'queued', alertIds: [alert.id], tierLabel: tier?.label },
      alertNames: [alert.name],
      receivedAt: new Date().toISOString(),
    });
    this.enqueue(job);
  }

  private enqueue(job: Job): void {
    this.queue.push(job);
    this.hooks.onState();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const ctrl = new AbortController();
    this.running = { job, ctrl };
    const alertIds = job.alerts.map((a) => a.alert.id);
    const tierLabel = job.alerts.find((a) => a.tier)?.tier?.label;
    const { tracks, totalMs } = this.player.plan({ alerts: job.alerts, event: job.event });
    this.nowPlaying = {
      alertNames: job.alerts.map((a) => a.alert.name),
      tierLabel,
      eventSummary: summarizeEvent(job.event),
      startedAt: Date.now(),
      durationMs: totalMs,
      lights: [...new Set(tracks.map((t) => t.light.name))],
    };
    this.hooks.onUpdate(job.event.id, { status: 'playing', alertIds, tierLabel });
    this.hooks.onState();
    if (tracks.length === 0) this.hooks.warn(`„${this.nowPlaying.alertNames.join(', ')}“ hat keine steuerbaren Lichter`);
    const after = job.alerts.some((a) => a.alert.after === 'restore') ? 'restore' : 'hold';
    try {
      await this.player.play({ alerts: job.alerts, event: job.event }, ctrl.signal, after);
    } catch (err) {
      this.hooks.warn(`Alert-Fehler: ${(err as Error).message}`);
    }
    this.hooks.onUpdate(job.event.id, { status: 'done', alertIds, tierLabel });
    this.running = null;
    this.nowPlaying = null;
    this.hooks.onState();
    void this.pump();
  }

  /** Alles stoppen: Warteschlange leeren, laufenden Alert abbrechen (Lichter gehen in den Ruhezustand). */
  stopAll(): void {
    for (const job of this.queue) this.hooks.onUpdate(job.event.id, { status: 'skipped', reason: 'Gestoppt' });
    this.queue = [];
    this.running?.ctrl.abort();
    this.hooks.onState();
  }
}
