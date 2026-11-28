import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import type { Light, NativeEffect, Rgb } from '@uelights/shared';
import { DriverError, fetchJson, type DriverCapabilities, type LightDriver } from './types.js';

const RT_PORT = 7777;

interface TwinklySnapshot {
  mode: string;
  brightness?: number;
  movieId?: number;
  effectId?: number;
  playlistId?: number;
  color?: { red: number; green: number; blue: number };
}

/**
 * Twinkly über die lokale (inoffizielle) xled-API:
 * HTTP auf Port 80 für Modi/Movies, UDP 7777 für Echtzeitbilder.
 * Doku: https://xled-docs.readthedocs.io
 */
export class TwinklyDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: true, color: true, native: true };
  private token: string | null = null;
  private tokenBytes: Buffer | null = null;
  private tokenExpires = 0;
  private leds = 250;
  private profile: 'RGB' | 'RGBW' = 'RGB';
  /** LEDs je Strang laut led/config (leer = unbekannt) */
  private strings: number[] = [];
  private infoLoaded = false;
  private product = '';
  private fw = '';
  private udp: dgram.Socket | null = null;

  constructor(readonly light: Light) {
    if (light.ledCount) this.leds = light.ledCount;
  }

  private get base(): string {
    const host = this.light.config.host;
    if (!host) throw new DriverError('Keine IP-Adresse für Twinkly hinterlegt');
    return `http://${host}/xled/v1`;
  }

  ledCount(): number {
    return this.leds;
  }

  private async login(): Promise<void> {
    const challenge = crypto.randomBytes(32).toString('base64');
    const r = await fetchJson(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge }),
    });
    const body = r.body as Record<string, unknown>;
    const token = body.authentication_token as string | undefined;
    if (!token) throw new DriverError(`Twinkly-Login fehlgeschlagen (${r.status})`);
    await fetchJson(`${this.base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ 'challenge-response': body['challenge-response'] }),
    });
    this.token = token;
    this.tokenBytes = Buffer.from(token, 'base64');
    const ttl = Number(body.authentication_token_expires_in ?? 14400);
    this.tokenExpires = Date.now() + Math.max(60, ttl - 60) * 1000;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<Record<string, unknown>> {
    if (!this.token || Date.now() > this.tokenExpires) await this.login();
    const r = await fetchJson(`${this.base}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': this.token! },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && !retried) {
      this.token = null;
      return this.call(method, path, body, true);
    }
    if (r.status >= 400) throw new DriverError(`Twinkly ${path}: HTTP ${r.status}`);
    return (r.body ?? {}) as Record<string, unknown>;
  }

  /**
   * Gerätedaten lesen: LED-Anzahl und Farbprofil aus gestalt, Aufteilung in Stränge aus led/config.
   * Mehrstrang-Controller (z. B. 2 × 250) melden in gestalt meist die Summe; zur Sicherheit gilt das Maximum.
   */
  async loadInfo(force = false): Promise<void> {
    if (this.infoLoaded && !force) return;
    const r = await fetchJson(`${this.base}/gestalt`);
    if (r.status >= 400) throw new DriverError(`Twinkly gestalt: HTTP ${r.status}`);
    const g = (r.body ?? {}) as Record<string, unknown>;
    const n = Number(g.number_of_led);
    this.profile = g.led_profile === 'RGBW' ? 'RGBW' : 'RGB';
    this.product = String(g.product_name ?? g.device_name ?? g.product_code ?? 'Twinkly');
    this.fw = String(g.fw_version ?? g.fw_family ?? '');
    try {
      const cfg = await this.call('GET', 'led/config');
      const list = (cfg.strings as Array<Record<string, unknown>> | undefined) ?? [];
      this.strings = list.map((x) => Number(x.length)).filter((x) => Number.isFinite(x) && x > 0);
    } catch {
      this.strings = [];
    }
    const sum = this.strings.reduce((a, b) => a + b, 0);
    const total = Math.max(Number.isFinite(n) ? n : 0, sum);
    if (total > 0) this.leds = total;
    this.infoLoaded = true;
  }

  /** Für die Anzeige, z. B. „500 LEDs · 2 Stränge (250 + 250)“ */
  describe(): string {
    const parts = [`${this.leds} LEDs`];
    if (this.strings.length > 1) parts.push(`${this.strings.length} Stränge (${this.strings.join(' + ')})`);
    parts.push(this.profile);
    return parts.join(' · ');
  }

  async probe() {
    try {
      await this.loadInfo(true);
      await this.login();
      return {
        ok: true,
        ledCount: this.leds,
        detail: `${this.product} · ${this.describe()}${this.fw ? ` · FW ${this.fw}` : ''}`,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private async setMode(mode: string, extra: Record<string, unknown> = {}) {
    await this.call('POST', 'led/mode', { mode, ...extra });
  }

  async snapshot(): Promise<TwinklySnapshot> {
    const m = await this.call('GET', 'led/mode');
    const snap: TwinklySnapshot = { mode: String(m.mode ?? 'movie') };
    try {
      const b = await this.call('GET', 'led/out/brightness');
      snap.brightness = Number(b.value ?? 100);
    } catch {
      /* optional */
    }
    try {
      if (snap.mode === 'movie') snap.movieId = Number((await this.call('GET', 'movies/current')).id);
      if (snap.mode === 'effect') snap.effectId = Number((await this.call('GET', 'led/effects/current')).effect_id);
      if (snap.mode === 'playlist') snap.playlistId = Number((await this.call('GET', 'playlist/current')).id);
      if (snap.mode === 'color') {
        const c = await this.call('GET', 'led/color');
        snap.color = { red: Number(c.red ?? 0), green: Number(c.green ?? 0), blue: Number(c.blue ?? 0) };
      }
    } catch {
      /* ältere Firmware */
    }
    return snap;
  }

  async restore(raw: unknown): Promise<void> {
    const s = raw as TwinklySnapshot;
    if (!s) return;
    if (s.brightness !== undefined) {
      await this.call('POST', 'led/out/brightness', { mode: 'enabled', type: 'A', value: s.brightness });
    }
    switch (s.mode) {
      case 'movie':
        if (Number.isFinite(s.movieId)) await this.call('POST', 'movies/current', { id: s.movieId });
        await this.setMode('movie');
        break;
      case 'effect':
        if (Number.isFinite(s.effectId)) await this.call('POST', 'led/effects/current', { effect_id: s.effectId });
        await this.setMode('effect');
        break;
      case 'playlist':
        await this.setMode('playlist');
        if (Number.isFinite(s.playlistId)) await this.call('POST', 'playlist/current', { id: s.playlistId });
        break;
      case 'color':
        if (s.color) await this.call('POST', 'led/color', s.color);
        await this.setMode('color');
        break;
      case 'off':
        await this.setMode('off');
        break;
      default:
        await this.setMode('movie');
    }
  }

  async setColor(c: Rgb, brightness: number): Promise<void> {
    await this.call('POST', 'led/color', { red: Math.round(c.r), green: Math.round(c.g), blue: Math.round(c.b) });
    await this.call('POST', 'led/out/brightness', { mode: 'enabled', type: 'A', value: Math.round(brightness) });
    await this.setMode('color');
  }

  async beginRealtime(): Promise<void> {
    await this.loadInfo().catch(() => undefined);
    await this.call('POST', 'led/out/brightness', { mode: 'enabled', type: 'A', value: 100 });
    await this.setMode('rt');
    if (!this.udp) {
      this.udp = dgram.createSocket('udp4');
      this.udp.on('error', () => undefined);
    }
  }

  /** Farbkanäle in der Reihenfolge des Geräts */
  private encodeLed(c: Rgb, out: number[]): void {
    const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b);
    const order = this.light.config.channelOrder ?? (this.profile === 'RGBW' ? 'WRGB' : 'RGB');
    if (order === 'RGB') out.push(r, g, b);
    else if (order === 'GRB') out.push(g, r, b);
    else {
      const w = Math.min(r, g, b);
      if (order === 'RGBW') out.push(r - w, g - w, b - w, w);
      else out.push(w, r - w, g - w, b - w);
    }
  }

  async sendFrame(leds: Rgb[]): Promise<void> {
    if (!this.udp || !this.tokenBytes) await this.beginRealtime();
    const bytes: number[] = [];
    for (let i = 0; i < this.leds; i++) this.encodeLed(leds[i % leds.length] ?? { r: 0, g: 0, b: 0 }, bytes);
    const data = Buffer.from(bytes);
    // Protokoll v3: 0x03 | Token (8 Byte) | 0x00 0x00 | Fragment-Nr. | max. 900 Byte Daten
    // UDP geht immer an Port 7777; eine eingetragene HTTP-Portangabe (IPv4) weglassen
    const host = this.light.config.host!.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
    for (let frag = 0, off = 0; off < data.length; frag++, off += 900) {
      const header = Buffer.concat([Buffer.from([0x03]), this.tokenBytes!, Buffer.from([0x00, 0x00, frag])]);
      const packet = Buffer.concat([header, data.subarray(off, off + 900)]);
      this.udp!.send(packet, RT_PORT, host);
    }
  }

  async listNative(): Promise<NativeEffect[]> {
    const out: NativeEffect[] = [];
    try {
      const movies = await this.call('GET', 'movies');
      for (const m of (movies.movies as Array<Record<string, unknown>>) ?? []) {
        out.push({ id: `movie:${m.id}`, name: String(m.name ?? `Movie ${m.id}`), kind: 'movie', data: { id: m.id } });
      }
    } catch {
      /* Firmware ohne Movie-Liste */
    }
    try {
      const pl = await this.call('GET', 'playlist');
      for (const e of (pl.entries as Array<Record<string, unknown>>) ?? []) {
        if (out.some((o) => o.kind === 'movie' && o.data?.id === e.id)) continue;
        out.push({ id: `playlist:${e.id}`, name: String(e.name ?? `Playlist ${e.id}`), kind: 'playlist', data: { id: e.id } });
      }
    } catch {
      /* optional */
    }
    try {
      const fx = await this.call('GET', 'led/effects');
      const n = Number(fx.effects_number ?? 0);
      for (let i = 0; i < n; i++) out.push({ id: `effect:${i}`, name: `Eingebauter Effekt ${i + 1}`, kind: 'effect', data: { id: i } });
    } catch {
      /* optional */
    }
    return out;
  }

  async playNative(n: NativeEffect): Promise<void> {
    const id = n.data?.id;
    if (n.kind === 'movie') {
      await this.call('POST', 'movies/current', { id });
      await this.setMode('movie');
    } else if (n.kind === 'effect') {
      await this.call('POST', 'led/effects/current', { effect_id: id });
      await this.setMode('effect');
    } else if (n.kind === 'playlist') {
      await this.setMode('playlist');
      await this.call('POST', 'playlist/current', { id });
    }
  }

  async off(): Promise<void> {
    await this.setMode('off');
  }

  dispose(): void {
    this.udp?.close();
    this.udp = null;
  }
}

/** Broadcast-Adressen aller IPv4-Netze dieses Rechners (plus 255.255.255.255). */
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      // Docker-/Container-Brücken überspringen
      if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) continue;
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

export interface TwinklyFound {
  ip: string;
  name: string;
  product?: string;
  ledCount?: number;
  strings?: number[];
  detail?: string;
}

/** Twinkly-Geräte im Netz finden (UDP-Broadcast an Port 5555) und Gerätedaten nachladen. */
export async function discoverTwinkly(timeoutMs = 2000): Promise<TwinklyFound[]> {
  const found = await new Promise<Map<string, string>>((resolve) => {
    const sock = dgram.createSocket('udp4');
    const map = new Map<string, string>();
    sock.on('message', (msg, rinfo) => {
      // Antwort: 4 Byte IP (umgekehrt) + "OK" + Gerätename + 0x00
      const name = msg.subarray(6).toString('utf8').replace(/\0.*$/, '');
      map.set(rinfo.address, name || 'Twinkly');
    });
    sock.on('error', () => undefined);
    const probe = Buffer.concat([Buffer.from([0x01]), Buffer.from('discover')]);
    sock.bind(() => {
      sock.setBroadcast(true);
      const send = () => broadcastAddresses().forEach((addr) => sock.send(probe, 5555, addr, () => undefined));
      send();
      setTimeout(send, 400);
    });
    setTimeout(() => {
      sock.close();
      resolve(map);
    }, timeoutMs);
  });

  return Promise.all(
    [...found].map(async ([ip, name]) => {
      const d = new TwinklyDriver({
        id: '', name, connector: 'twinkly', config: { host: ip }, role: 'deco', enabled: true,
        restState: { mode: 'snapshot' }, nativeEffects: [],
      } as unknown as Light);
      try {
        await d.loadInfo();
        return { ip, name, ledCount: d.ledCount(), detail: d.describe() };
      } catch {
        return { ip, name };
      }
    }),
  );
}
