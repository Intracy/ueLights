import {
  amountRatio,
  effectiveDuration,
  parseColorFromText,
  renderEffect,
  solidEffect,
  splitBrightness,
  type Alert,
  type Effect,
  type Group,
  type Light,
  type NormalizedEvent,
  type Rgb,
  type Settings,
  type Tier,
  type Track,
} from '@uelights/shared';
import type { DriverRegistry } from '../connectors/registry.js';
import type { LightDriver } from '../connectors/types.js';

export interface PlayerDeps {
  registry: DriverRegistry;
  getLights: () => Light[];
  getGroups: () => Group[];
  getEffects: () => Effect[];
  getSettings: () => Settings;
  warn: (msg: string) => void;
}

/** Ein geplanter Track auf genau einem Licht */
interface PlannedTrack {
  light: Light;
  driver: LightDriver;
  track: Track;
  durationMs: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

function sameColor(a: Rgb | null, b: Rgb): boolean {
  if (!a) return false;
  return Math.abs(a.r - b.r) < 2 && Math.abs(a.g - b.g) < 2 && Math.abs(a.b - b.b) < 2;
}

export interface PlayRequest {
  alerts: Array<{ alert: Alert; tier?: Tier }>;
  event?: NormalizedEvent;
}

/**
 * Spielt Alerts auf den Lichtern ab:
 * – Echtzeit-Lichter (Twinkly, virtuell) bekommen Einzel-LED-Bilder
 * – andere Lichter bekommen gedrosselte Farbbefehle
 * – Hersteller-Effekte werden einmal gestartet und nach Ablauf beendet
 * Danach wird jedes beteiligte Licht in seinen Ruhezustand versetzt.
 */
export class Player {
  constructor(private deps: PlayerDeps) {}

  /** Lichter eines Tracks auflösen (Gruppe → Lichter), gesperrte und deaktivierte überspringen. */
  resolveLights(track: Track): Light[] {
    const lights = this.deps.getLights();
    const settings = this.deps.getSettings();
    let ids: string[] = [];
    if (track.target.kind === 'light') ids = [track.target.lightId];
    else {
      const targetGroupId = track.target.groupId;
      ids = this.deps.getGroups().find((g) => g.id === targetGroupId)?.lightIds ?? [];
    }
    return ids
      .map((id) => lights.find((l) => l.id === id))
      .filter((l): l is Light => !!l && l.enabled)
      .filter((l) => !(settings.safety.lockSceneLights && l.role === 'scene'));
  }

  private effectFor(track: Track, ev?: NormalizedEvent, extra?: Effect): Effect | null {
    if (track.effect.type === 'own') {
      const id = track.effect.effectId;
      if (extra && extra.id === id) return extra;
      return this.deps.getEffects().find((e) => e.id === id) ?? null;
    }
    if (track.effect.type === 'eventColor') {
      const color = parseColorFromText(ev?.message) ?? parseColorFromText(ev?.reward) ?? track.effect.fallback;
      return solidEffect(color, track.effect.brightness, track.durationMs ?? 8000);
    }
    return null;
  }

  /** Gesamtdauer eines Alerts (für Fortschrittsanzeige) */
  plan(req: PlayRequest): { tracks: PlannedTrack[]; totalMs: number } {
    const tracks: PlannedTrack[] = [];
    let totalMs = 0;
    for (const { alert, tier } of req.alerts) {
      const list = alert.mode === 'tiers' ? tier?.tracks ?? [] : alert.tracks;
      for (const track of list) {
        const effect = this.effectFor(track, req.event);
        const ratio = effect ? amountRatio(effect.amountMapping, req.event?.amount) : undefined;
        const durationMs = effect ? effectiveDuration(effect, ratio, track.durationMs) : track.durationMs ?? 5000;
        for (const light of this.resolveLights(track)) {
          tracks.push({ light, driver: this.deps.registry.get(light), track, durationMs });
          totalMs = Math.max(totalMs, track.offsetMs + durationMs);
        }
      }
    }
    return { tracks, totalMs };
  }

  async play(req: PlayRequest, signal: AbortSignal, after: 'restore' | 'hold'): Promise<void> {
    const { tracks } = this.plan(req);
    const lights = new Map<string, { light: Light; driver: LightDriver }>();
    for (const t of tracks) lights.set(t.light.id, { light: t.light, driver: t.driver });

    // Zustand vor dem Alert sichern (nur für Ruhezustand "wie vorher")
    const snapshots = new Map<string, unknown>();
    if (after === 'restore') {
      await Promise.all(
        [...lights.values()]
          .filter(({ light }) => light.restState.mode === 'snapshot')
          .map(async ({ light, driver }) => {
            try {
              snapshots.set(light.id, await driver.snapshot());
            } catch (err) {
              this.deps.warn(`${light.name}: Zustand nicht lesbar – ${(err as Error).message}`);
            }
          }),
      );
    }

    // Spuren auf demselben Licht laufen nacheinander nach Startzeit; verschiedene Lichter parallel
    const byLight = new Map<string, PlannedTrack[]>();
    for (const t of tracks) {
      const list = byLight.get(t.light.id) ?? [];
      list.push(t);
      byLight.set(t.light.id, list);
    }
    const started = Date.now();
    await Promise.all(
      [...byLight.values()].map(async (list) => {
        list.sort((a, b) => a.track.offsetMs - b.track.offsetMs);
        for (const pt of list) {
          await sleep(started + pt.track.offsetMs - Date.now(), signal);
          if (signal.aborted) return;
          try {
            await this.runTrack(pt, req, signal);
          } catch (err) {
            this.deps.warn(`${pt.light.name}: ${(err as Error).message}`);
          }
        }
      }),
    );

    if (after === 'restore' || signal.aborted) {
      await Promise.all(
        [...lights.values()].map(({ light, driver }) => this.applyRest(light, driver, snapshots.get(light.id))),
      );
    }
  }

  private async runTrack(pt: PlannedTrack, req: PlayRequest, signal: AbortSignal, extra?: Effect): Promise<void> {
    const { track, driver, light } = pt;
    const alertName = req.alerts.map((a) => a.alert.name).join(' + ');

    if (track.effect.type === 'native') {
      const nativeId = track.effect.nativeId;
      const native = light.nativeEffects.find((n) => n.id === nativeId);
      if (!native) throw new Error(`Hersteller-Effekt nicht gefunden (neu einlesen?)`);
      await driver.playNative(native, { event: req.event, alertName });
      await sleep(pt.durationMs, signal);
      return;
    }

    const effect = this.effectFor(track, req.event, extra);
    if (!effect) throw new Error('Effekt nicht gefunden');
    const settings = this.deps.getSettings();
    const ratio = amountRatio(effect.amountMapping, req.event?.amount);
    const realtime = driver.capabilities.realtime && !!driver.sendFrame;
    const fps = realtime ? Math.max(5, Math.min(40, settings.realtimeFps)) : Math.max(1, Math.min(10, settings.colorCommandRate));
    const interval = 1000 / fps;
    const ledCount = realtime ? driver.ledCount() : 1;
    const ctx = { ledCount, amountRatio: ratio, maxFlashHz: settings.safety.maxFlashHz, durationMs: pt.durationMs };

    if (realtime) await driver.beginRealtime?.();
    const t0 = Date.now();
    let last: Rgb | null = null;
    let lastB = -1;
    while (!signal.aborted) {
      const t = Date.now() - t0;
      if (t > pt.durationMs) break;
      const frame = renderEffect(effect, t, ctx);
      if (realtime) {
        await driver.sendFrame!(frame.leds);
      } else {
        const { color, brightness } = splitBrightness(frame.solid);
        if (!sameColor(last, color) || Math.abs(brightness - lastB) >= 2) {
          await driver.setColor(color, brightness);
          last = color;
          lastB = brightness;
        }
      }
      const spent = Date.now() - t0 - t;
      await sleep(Math.max(5, interval - spent), signal);
    }
  }

  async applyRest(light: Light, driver: LightDriver, snapshot?: unknown): Promise<void> {
    try {
      const rest = light.restState;
      if (rest.mode === 'snapshot') {
        if (snapshot !== undefined) await driver.restore(snapshot);
      } else if (rest.mode === 'off') {
        await driver.off();
      } else if (rest.mode === 'color') {
        const { color } = splitBrightness(hexRgb(rest.color));
        await driver.setColor(color, rest.brightness);
      } else if (rest.mode === 'native') {
        const nativeId = rest.nativeId;
        const n = light.nativeEffects.find((x) => x.id === nativeId);
        if (n) await driver.playNative(n, {});
      }
    } catch (err) {
      this.deps.warn(`${light.name}: Ruhezustand nicht gesetzt – ${(err as Error).message}`);
    }
  }

  /** Licht kurz blinken lassen, damit man es im Raum findet. */
  async identify(light: Light): Promise<void> {
    const blink: Effect = { ...solidEffect('#ffffff', 100, 3000), id: '__identify', kind: 'strobe', speed: 1.5, brightnessMin: 0 };
    await this.preview({ ...light, restState: { mode: 'snapshot' } }, blink);
  }

  /** Einen Effekt direkt auf einem Licht testen und danach den Ruhezustand herstellen. */
  async preview(light: Light, effect: Effect, amount?: number): Promise<void> {
    const driver = this.deps.registry.get(light);
    let snap: unknown;
    if (light.restState.mode === 'snapshot') snap = await driver.snapshot().catch(() => undefined);
    const ratio = amountRatio(effect.amountMapping, amount);
    try {
      await this.runTrack(
        {
          light,
          driver,
          track: { id: 'preview', target: { kind: 'light', lightId: light.id }, effect: { type: 'own', effectId: effect.id }, offsetMs: 0 },
          durationMs: effectiveDuration(effect, ratio),
        },
        { alerts: [], event: amount !== undefined ? ({ amount } as NormalizedEvent) : undefined },
        new AbortController().signal,
        effect,
      );
    } finally {
      await this.applyRest(light, driver, snap);
    }
  }

  /** Einen Hersteller-Effekt kurz anspielen. */
  async previewNative(light: Light, nativeId: string, durationMs = 5000): Promise<void> {
    const driver = this.deps.registry.get(light);
    const native = light.nativeEffects.find((n) => n.id === nativeId);
    if (!native) throw new Error('Hersteller-Effekt nicht gefunden');
    let snap: unknown;
    if (light.restState.mode === 'snapshot') snap = await driver.snapshot().catch(() => undefined);
    try {
      await driver.playNative(native, {});
      await new Promise((r) => setTimeout(r, durationMs));
    } finally {
      await this.applyRest(light, driver, snap);
    }
  }
}

function hexRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
}
