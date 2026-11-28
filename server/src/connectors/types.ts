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

/** JSON lesen und nur Objekte zurückgeben (null, Zahlen, Text und Arrays ergeben null) */
export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** amaran-Adresse vervollständigen: „192.168.0.25:33783“ → „ws://192.168.0.25:33783/ws“ */
export function normalizeWsUrl(raw: string, defaultPort = 33782): string {
  let u = raw.trim();
  if (!u) return u;
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u.replace(/^https?:\/\//i, '')}`;
  try {
    const url = new URL(u);
    if (!url.port && !/^wss:/i.test(u)) url.port = String(defaultPort);
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
    return url.toString();
  } catch {
    return u;
  }
}
