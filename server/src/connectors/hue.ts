import dgram from 'node:dgram';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { ConnectionStatus, Light, NativeEffect, Rgb, Settings } from '@uelights/shared';
import { DriverError, type DriverCapabilities, type LightDriver } from './types.js';

/**
 * Philips Hue über die lokale Bridge (CLIP API v2, HTTPS im Heimnetz).
 * Kopplung per Link-Taste; das Bridge-Zertifikat wird beim Koppeln gemerkt und danach geprüft.
 */

type Xy = { x: number; y: number };
type Gamut = { red: Xy; green: Xy; blue: Xy };

export interface HueResource {
  id: string;
  type: string;
  metadata?: { name?: string; archetype?: string };
  owner?: { rid: string; rtype: string };
  on?: { on: boolean };
  dimming?: { brightness: number };
  color?: { xy: Xy; gamut?: Gamut };
  color_temperature?: { mirek: number | null; mirek_valid?: boolean };
  effects?: { effect_values?: string[]; status?: string };
  children?: Array<{ rid: string; rtype: string }>;
  services?: Array<{ rid: string; rtype: string }>;
  group?: { rid: string; rtype: string };
  palette?: { color?: unknown[] };
  bridge_id?: string;
}

export interface HueTarget {
  /** Ressource, die geschaltet wird: light oder grouped_light */
  id: string;
  type: 'light' | 'grouped_light';
  name: string;
  /** Lampe, Raum oder Zone */
  kind: 'Lampe' | 'Raum' | 'Zone' | 'Alle';
  /** Raum/Zone (für Szenen) */
  groupId?: string;
  color: boolean;
}

// ------------------------------------------------------------ Farbe → xy

/** sRGB → CIE xy (Wide-Gamut-D65-Matrix wie in der Hue-Doku), auf den Farbraum der Lampe begrenzt */
export function rgbToXy(c: Rgb, gamut?: Gamut): Xy {
  const lin = (v: number) => {
    const n = Math.max(0, Math.min(255, v)) / 255;
    return n > 0.04045 ? ((n + 0.055) / 1.055) ** 2.4 : n / 12.92;
  };
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  let p: Xy = sum === 0 ? { x: 0.3127, y: 0.329 } : { x: X / sum, y: Y / sum };
  if (gamut) p = clampToGamut(p, gamut);
  return { x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 };
}

function cross(a: Xy, b: Xy) {
  return a.x * b.y - a.y * b.x;
}

function closestOnLine(a: Xy, b: Xy, p: Xy): Xy {
  const ap = { x: p.x - a.x, y: p.y - a.y };
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / (ab.x * ab.x + ab.y * ab.y)));
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function clampToGamut(p: Xy, { red, green, blue }: Gamut): Xy {
  const v1 = { x: green.x - red.x, y: green.y - red.y };
  const v2 = { x: blue.x - red.x, y: blue.y - red.y };
  const q = { x: p.x - red.x, y: p.y - red.y };
  const s = cross(q, v2) / cross(v1, v2);
  const t = cross(v1, q) / cross(v1, v2);
  if (s >= 0 && t >= 0 && s + t <= 1) return p;
  const cands = [closestOnLine(red, green, p), closestOnLine(blue, red, p), closestOnLine(green, blue, p)];
  const d = (a: Xy) => (a.x - p.x) ** 2 + (a.y - p.y) ** 2;
  return cands.sort((a, b) => d(a) - d(b))[0];
}

// ------------------------------------------------------------ HTTPS

interface HttpResult {
  status: number;
  body: unknown;
  fingerprint?: string;
}

// Ohne TLS-Sitzungs-Cache: bei wiederaufgenommenen Sitzungen fehlt sonst das Zertifikat für die Prüfung
const hueAgent = new https.Agent({ keepAlive: true, maxSockets: 4, maxCachedSessions: 0 });

function hueRequest(
  host: string,
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; fingerprint?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const [hostname, port] = host.includes(':') && !host.startsWith('[') ? host.split(':') : [host, '443'];
    const req = https.request(
      {
        hostname,
        port: Number(port) || 443,
        method,
        path,
        agent: hueAgent,
        // Die Bridge hat ein von Signify signiertes Zertifikat ohne öffentliche Kette;
        // stattdessen wird der beim Koppeln gemerkte Fingerabdruck geprüft (siehe unten).
        rejectUnauthorized: false,
        headers: {
          ...(opts.key ? { 'hue-application-key': opts.key } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        },
        timeout: opts.timeoutMs ?? 4000,
      },
      (res) => {
        const fp = (res.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256;
        // Auch bei wiederverwendeten Verbindungen prüfen
        if (opts.fingerprint && fp !== opts.fingerprint) {
          res.resume();
          reject(new DriverError('Zertifikat der Hue Bridge hat sich geändert – bitte neu koppeln'));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* kein JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, fingerprint: fp });
        });
      },
    );
    req.on('socket', (sock) => {
      sock.once('secureConnect', () => {
        const fp = (sock as TLSSocket).getPeerCertificate()?.fingerprint256;
        if (opts.fingerprint && fp && fp !== opts.fingerprint) {
          req.destroy(new DriverError('Zertifikat der Hue Bridge hat sich geändert – bitte neu koppeln'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new DriverError('Hue Bridge antwortet nicht')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ------------------------------------------------------------ Bridge-Suche

/** Hue Bridges im Netz finden: SSDP (UDP 1900) und mDNS (_hue._tcp), ohne Cloud. */
export async function discoverHueBridges(timeoutMs = 3000): Promise<Array<{ ip: string; name: string; bridgeId?: string }>> {
  const ips = new Set<string>();
  await new Promise<void>((resolve) => {
    const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const mdns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    ssdp.on('message', (msg, r) => {
      const t = msg.toString();
      if (/hue-bridgeid|IpBridge|philips/i.test(t)) ips.add(r.address);
    });
    mdns.on('message', (msg, r) => {
      if (msg.includes(Buffer.from('_hue'))) ips.add(r.address);
    });
    ssdp.on('error', () => undefined);
    mdns.on('error', () => undefined);
    ssdp.bind(() => {
      const m = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n',
      );
      ssdp.send(m, 1900, '239.255.255.250', () => undefined);
      setTimeout(() => ssdp.send(m, 1900, '239.255.255.250', () => undefined), 500);
    });
    mdns.bind(() => {
      // DNS-Anfrage: PTR _hue._tcp.local, Antwort per Unicast erbeten (QU-Bit)
      const labels = ['_hue', '_tcp', 'local'];
      const q = Buffer.concat([
        Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
        Buffer.from([0, 0, 12, 0x80, 1]),
      ]);
      mdns.send(q, 5353, '224.0.0.251', () => undefined);
    });
    setTimeout(() => {
      ssdp.close();
      mdns.close();
      resolve();
    }, timeoutMs);
  });

  const out: Array<{ ip: string; name: string; bridgeId?: string }> = [];
  for (const ip of ips) {
    try {
      const r = await hueRequest(ip, 'GET', '/api/0/config', { timeoutMs: 2000 });
      const c = r.body as Record<string, unknown>;
      if (c && (c.bridgeid || c.modelid)) out.push({ ip, name: String(c.name ?? 'Hue Bridge'), bridgeId: String(c.bridgeid ?? '') });
    } catch {
      /* keine Bridge */
    }
  }
  return out;
}

/** Mit der Bridge koppeln. Vorher muss die Link-Taste gedrückt worden sein. */
export async function pairHueBridge(ip: string): Promise<{ appKey: string; clientKey?: string; fingerprint?: string }> {
  const r = await hueRequest(ip, 'POST', '/api', { body: { devicetype: 'uelights#server', generateclientkey: true } });
  const first = (Array.isArray(r.body) ? r.body[0] : r.body) as Record<string, Record<string, unknown>> | undefined;
  if (first?.success?.username) {
    return { appKey: String(first.success.username), clientKey: first.success.clientkey as string | undefined, fingerprint: r.fingerprint };
  }
  if (Number(first?.error?.type) === 101) throw new DriverError('Link-Taste auf der Hue Bridge drücken und innerhalb von 30 Sekunden erneut koppeln');
  throw new DriverError(`Koppeln fehlgeschlagen: ${String(first?.error?.description ?? r.status)}`);
}

// ------------------------------------------------------------ Client

interface Pending {
  type: string;
  id: string;
  body: Record<string, unknown>;
  waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
}

export class HueClient {
  status: ConnectionStatus = { id: 'hue', label: 'Philips Hue', state: 'disabled' };
  private cache = new Map<string, HueResource[]>();
  private cacheAt = 0;
  private queue = new Map<string, Pending>();
  private lastGroupSend = new Map<string, number>();
  private pump: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private getSettings: () => Settings['hue'], private onStatus: () => void) {}

  private setStatus(state: ConnectionStatus['state'], detail?: string) {
    this.status = { ...this.status, state, detail };
    this.onStatus();
  }

  get configured(): boolean {
    const s = this.getSettings();
    return !!(s.enabled && s.bridgeIp && s.appKey);
  }

  async restart(): Promise<void> {
    this.stop();
    const s = this.getSettings();
    if (!s.enabled) return this.setStatus('disabled');
    if (!s.bridgeIp) return this.setStatus('error', 'Keine Bridge gewählt');
    if (!s.appKey) return this.setStatus('error', 'Noch nicht gekoppelt – Link-Taste drücken und „Koppeln“');
    this.setStatus('connecting', s.bridgeIp);
    this.pump = setInterval(() => this.flush(), 100);
    try {
      await this.refresh();
      const lights = this.cache.get('light')?.length ?? 0;
      const rooms = this.cache.get('room')?.length ?? 0;
      this.setStatus('ok', `${s.bridgeIp} · ${lights} Lampen · ${rooms} Räume`);
    } catch (err) {
      this.setStatus('error', (err as Error).message);
      this.retryTimer = setTimeout(() => this.restart(), 30_000);
    }
  }

  stop(): void {
    if (this.pump) clearInterval(this.pump);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pump = null;
    for (const p of this.queue.values()) for (const w of p.waiters) w.reject(new DriverError('Hue gestoppt'));
    this.queue.clear();
    this.setStatus('disabled');
  }

  async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const s = this.getSettings();
    if (!s.bridgeIp || !s.appKey) throw new DriverError('Hue Bridge nicht gekoppelt');
    const r = await hueRequest(s.bridgeIp, method, `/clip/v2${path}`, { key: s.appKey, body, fingerprint: s.certFingerprint || undefined });
    const b = r.body as { data?: unknown; errors?: Array<{ description?: string }> };
    if (r.status === 403 || r.status === 401) throw new DriverError('Hue: Schlüssel ungültig – neu koppeln');
    if (r.status >= 400) throw new DriverError(`Hue ${path}: ${b?.errors?.[0]?.description ?? `HTTP ${r.status}`}`);
    return b?.data;
  }

  async refresh(): Promise<void> {
    const types = ['light', 'grouped_light', 'room', 'zone', 'device', 'scene', 'bridge_home'];
    // Lampen sind Pflicht (Fehler wie falscher Schlüssel oder fremdes Zertifikat kommen hier an), der Rest optional
    const res = await Promise.all(types.map((t, i) => (i === 0 ? this.api('GET', `/resource/${t}`) : this.api('GET', `/resource/${t}`).catch(() => []))));
    types.forEach((t, i) => this.cache.set(t, (res[i] as HueResource[]) ?? []));
    this.cacheAt = Date.now();
  }

  async resources(type: string, maxAgeMs = 60_000): Promise<HueResource[]> {
    if (Date.now() - this.cacheAt > maxAgeMs) await this.refresh();
    return this.cache.get(type) ?? [];
  }

  /** Alle steuerbaren Ziele: Lampen, Räume, Zonen und „Alle Lampen“ */
  async targets(): Promise<HueTarget[]> {
    await this.refresh();
    const lights = this.cache.get('light') ?? [];
    const groupOf = (g: HueResource) => g.services?.find((s) => s.rtype === 'grouped_light')?.rid;
    const out: HueTarget[] = lights.map((l) => ({
      id: l.id,
      type: 'light' as const,
      name: l.metadata?.name ?? 'Hue-Lampe',
      kind: 'Lampe' as const,
      groupId: this.roomOfLight(l.id),
      color: !!l.color,
    }));
    for (const [t, kind] of [['room', 'Raum'], ['zone', 'Zone']] as const) {
      for (const g of this.cache.get(t) ?? []) {
        const gl = groupOf(g);
        if (gl) out.push({ id: gl, type: 'grouped_light', name: g.metadata?.name ?? kind, kind, groupId: g.id, color: true });
      }
    }
    const home = (this.cache.get('bridge_home') ?? [])[0];
    const homeGl = home && groupOf(home);
    if (homeGl) out.push({ id: homeGl, type: 'grouped_light', name: 'Alle Hue-Lampen', kind: 'Alle', groupId: home.id, color: true });
    return out;
  }

  /** Raum, zu dem eine Lampe gehört */
  roomOfLight(lightId: string): string | undefined {
    const device = (this.cache.get('device') ?? []).find((d) => d.services?.some((s) => s.rid === lightId));
    if (!device) return undefined;
    return (this.cache.get('room') ?? []).find((r) => r.children?.some((c) => c.rid === device.id))?.id;
  }

  /** Lampen in einem Raum, einer Zone oder dem ganzen Zuhause */
  lightsInGroup(groupId: string): string[] {
    const all = [...(this.cache.get('room') ?? []), ...(this.cache.get('zone') ?? []), ...(this.cache.get('bridge_home') ?? [])];
    const g = all.find((x) => x.id === groupId);
    if (!g) return [];
    const devices = this.cache.get('device') ?? [];
    const out = new Set<string>();
    for (const c of g.children ?? []) {
      if (c.rtype === 'light') out.add(c.rid);
      if (c.rtype === 'device') devices.find((d) => d.id === c.rid)?.services?.filter((s) => s.rtype === 'light').forEach((s) => out.add(s.rid));
      if (c.rtype === 'room') this.lightsInGroup(c.rid).forEach((id) => out.add(id));
    }
    return [...out];
  }

  findResource(type: string, id: string): HueResource | undefined {
    return (this.cache.get(type) ?? []).find((r) => r.id === id);
  }

  /**
   * Befehl in die Warteschlange. Gleiche Ziele werden zusammengefasst (der neueste Stand gewinnt).
   * Die Bridge verträgt etwa 10 Befehle/s für Lampen und 1/s je Raum.
   */
  send(type: string, id: string, body: Record<string, unknown>): Promise<void> {
    const key = `${type}/${id}`;
    return new Promise((resolve, reject) => {
      const p = this.queue.get(key);
      if (p) {
        p.body = mergeBody(p.body, body);
        p.waiters.push({ resolve, reject });
      } else {
        this.queue.set(key, { type, id, body, waiters: [{ resolve, reject }] });
      }
    });
  }

  private flush(): void {
    const now = Date.now();
    for (const [key, p] of this.queue) {
      if (p.type === 'grouped_light' && now - (this.lastGroupSend.get(p.id) ?? 0) < 1000) continue;
      this.queue.delete(key);
      if (p.type === 'grouped_light') this.lastGroupSend.set(p.id, now);
      this.api('PUT', `/resource/${p.type}/${p.id}`, p.body).then(
        () => p.waiters.forEach((w) => w.resolve()),
        (err) => p.waiters.forEach((w) => w.reject(err)),
      );
      return; // höchstens ein Befehl je 100 ms
    }
  }
}

function mergeBody(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a, ...b };
  // Szene/Effekt-Befehle nicht mit Farbe mischen
  if ('color' in b || 'color_temperature' in b) delete out.effects;
  return out;
}

// ------------------------------------------------------------ Treiber

interface LightState {
  id: string;
  on: boolean;
  brightness?: number;
  xy?: Xy;
  mirek?: number;
}

export class HueDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: false, color: true, native: true };

  constructor(readonly light: Light, private hue: HueClient, private getRate: () => number) {}

  private get target(): { type: 'light' | 'grouped_light'; id: string } {
    const id = this.light.config.hueId;
    if (!id) throw new DriverError('Keine Hue-Lampe oder kein Raum gewählt');
    return { type: this.light.config.hueType === 'grouped_light' ? 'grouped_light' : 'light', id };
  }

  ledCount(): number {
    return 1;
  }

  /** Lampen-IDs hinter diesem Licht */
  private async memberLights(): Promise<string[]> {
    const t = this.target;
    if (t.type === 'light') return [t.id];
    await this.hue.resources('grouped_light');
    const gl = this.hue.findResource('grouped_light', t.id);
    return gl?.owner ? this.hue.lightsInGroup(gl.owner.rid) : [];
  }

  async probe() {
    try {
      await this.hue.refresh();
      const t = this.target;
      const r = this.hue.findResource(t.type, t.id);
      if (!r) return { ok: false, detail: 'Nicht mehr auf der Bridge – neu wählen' };
      const n = t.type === 'grouped_light' ? `${(await this.memberLights()).length} Lampen` : r.color ? 'Farbe' : 'Weiß';
      return { ok: true, detail: `${t.type === 'light' ? 'Lampe' : 'Gruppe'} · ${n} · ${r.on?.on ? 'an' : 'aus'}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async snapshot(): Promise<LightState[]> {
    const ids = await this.memberLights();
    const all = (await this.hue.api('GET', '/resource/light')) as HueResource[];
    return all
      .filter((l) => ids.includes(l.id))
      .map((l) => ({
        id: l.id,
        on: !!l.on?.on,
        brightness: l.dimming?.brightness,
        xy: l.color_temperature?.mirek_valid ? undefined : l.color?.xy,
        mirek: l.color_temperature?.mirek_valid ? (l.color_temperature.mirek ?? undefined) : undefined,
      }));
  }

  async restore(raw: unknown): Promise<void> {
    const list = (raw as LightState[]) ?? [];
    await Promise.all(
      list.map((s) => {
        const body: Record<string, unknown> = { on: { on: s.on }, dynamics: { duration: 400 } };
        if (s.on) {
          if (s.brightness !== undefined) body.dimming = { brightness: s.brightness };
          if (s.mirek) body.color_temperature = { mirek: s.mirek };
          else if (s.xy) body.color = { xy: s.xy };
        }
        return this.hue.send('light', s.id, body);
      }),
    );
  }

  async setColor(c: Rgb, brightness: number): Promise<void> {
    const t = this.target;
    const res = this.hue.findResource(t.type, t.id) ?? (await this.hue.resources(t.type)).find((r) => r.id === t.id);
    if (brightness <= 0.5) {
      await this.hue.send(t.type, t.id, { on: { on: false }, dynamics: { duration: 0 } });
      return;
    }
    // Übergang ungefähr so lang wie ein Bild, damit Effekte weich laufen
    const frameMs = Math.round(1000 / Math.max(1, Math.min(10, this.getRate())));
    const body: Record<string, unknown> = {
      on: { on: true },
      dimming: { brightness: Math.max(1, Math.min(100, Math.round(brightness))) },
      dynamics: { duration: t.type === 'grouped_light' ? 300 : Math.min(400, frameMs) },
    };
    if (t.type === 'grouped_light' || res?.color) body.color = { xy: rgbToXy(c, res?.color?.gamut) };
    await this.hue.send(t.type, t.id, body);
  }

  async listNative(): Promise<NativeEffect[]> {
    await this.hue.refresh();
    const t = this.target;
    const out: NativeEffect[] = [];
    // Szenen des Raums/der Zone (bei Einzellampen: Szenen ihres Raums)
    const groupId = t.type === 'light' ? this.hue.roomOfLight(t.id) : this.hue.findResource('grouped_light', t.id)?.owner?.rid;
    for (const sc of await this.hue.resources('scene', 0)) {
      if (groupId && sc.group?.rid !== groupId) continue;
      const name = sc.metadata?.name ?? 'Szene';
      out.push({ id: `scene:${sc.id}`, name: `Szene: ${name}`, kind: 'scene', data: { sceneId: sc.id, action: 'active' } });
      if ((sc.palette?.color?.length ?? 0) > 1) {
        out.push({ id: `scene-dyn:${sc.id}`, name: `Szene: ${name} (dynamisch)`, kind: 'scene', data: { sceneId: sc.id, action: 'dynamic_palette' } });
      }
    }
    // Lampen-Effekte (Kerze, Feuer, Funkeln …)
    const ids = await this.memberLights();
    const values = new Set<string>();
    for (const id of ids) for (const v of this.hue.findResource('light', id)?.effects?.effect_values ?? []) if (v !== 'no_effect') values.add(v);
    for (const v of values) out.push({ id: `effect:${v}`, name: `Effekt: ${EFFECT_NAMES[v] ?? v}`, kind: 'effect', data: { effect: v } });
    return out;
  }

  async playNative(n: NativeEffect): Promise<void> {
    if (n.kind === 'scene') {
      await this.hue.api('PUT', `/resource/scene/${n.data?.sceneId}`, { recall: { action: n.data?.action ?? 'active' } });
      return;
    }
    if (n.kind === 'effect') {
      const ids = await this.memberLights();
      await Promise.all(ids.map((id) => this.hue.send('light', id, { on: { on: true }, effects: { effect: n.data?.effect } })));
    }
  }

  async off(): Promise<void> {
    const t = this.target;
    await this.hue.send(t.type, t.id, { on: { on: false } });
  }
}

const EFFECT_NAMES: Record<string, string> = {
  candle: 'Kerze',
  fire: 'Kaminfeuer',
  prism: 'Prisma',
  sparkle: 'Funkeln',
  opal: 'Opal',
  glisten: 'Glitzern',
  underwater: 'Unterwasser',
  cosmos: 'Kosmos',
  sunbeam: 'Sonnenstrahl',
  enchant: 'Zauber',
};
