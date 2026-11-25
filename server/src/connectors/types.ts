import type { Light, NativeEffect, NormalizedEvent, Rgb } from '@uelights/shared';

export interface DriverCapabilities {
  /** Einzel-LED-Echtzeitbilder möglich (Twinkly, virtuell) */
  realtime: boolean;
  /** Farbe/Helligkeit setzbar */
  color: boolean;
  /** Hersteller-Effekte abspielbar */
  native: boolean;
}

export interface PlayContext {
  event?: NormalizedEvent;
  alertName?: string;
}

/** Ein Treiber steuert genau ein Licht. */
export interface LightDriver {
  readonly light: Light;
  readonly capabilities: DriverCapabilities;
  /** LED-Anzahl für Echtzeitbilder (1 bei einfachen Lampen) */
  ledCount(): number;
  /** Erreichbarkeit prüfen und Gerätedaten laden */
  probe(): Promise<{ ok: boolean; detail?: string; ledCount?: number }>;
  snapshot(): Promise<unknown>;
  restore(snapshot: unknown): Promise<void>;
  /** Farbe setzen, Helligkeit 0–100 */
  setColor(color: Rgb, brightness: number): Promise<void>;
  /** Echtzeit-Modus vorbereiten (einmal je Effekt) */
  beginRealtime?(): Promise<void>;
  sendFrame?(leds: Rgb[]): Promise<void>;
  playNative(effect: NativeEffect, ctx: PlayContext): Promise<void>;
  /** Hersteller-Effekte vom Gerät/der App einlesen */
  listNative(): Promise<NativeEffect[]>;
  off(): Promise<void>;
  dispose?(): void;
}

export class DriverError extends Error {}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 3000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* Text-Antwort */
    }
    return { status: res.status, body };
  } catch (err) {
    throw new DriverError(`${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}
