import crypto from 'node:crypto';
import WebSocket from 'ws';
import { rgbToHsv, type ConnectionStatus, type Light, type NativeEffect, type Rgb, type Settings } from '@uelights/shared';
import { DriverError, normalizeWsUrl, parseObject, type DriverCapabilities, type LightDriver } from './types.js';

interface Waiter {
  action: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Schlüssel aus dem amaran-OpenAPI-Key: 64 Hex-Zeichen oder Base64 mit 32 Byte direkt,
 * sonst SHA-256 des Textes. Ohne Key ein Zufallsschlüssel (ältere Desktop-Versionen prüfen nicht).
 */
export function amaranKeyBytes(apiKey: string): Buffer {
  const k = apiKey.trim();
  if (!k) return crypto.randomBytes(32);
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, 'hex');
  if (/^[A-Za-z0-9+/_-]+=*$/.test(k)) {
    const b = Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return crypto.createHash('sha256').update(k, 'utf8').digest();
}

/** Anfrage-Token nach amaran OpenAPI: AES-256-GCM über den Unix-Zeitstempel, Base64 von IV(12) | Tag(16) | Chiffrat */
export function amaranToken(apiKey: string, now = Date.now()): string {
  const key = amaranKeyBytes(apiKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(Math.floor(now / 1000)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/**
 * Verbindung zur amaran-Desktop-App (lokaler WebSocket, Standard-Port 33782).
 * Die App hält die Bluetooth-Verbindung zu den Leuchten. Protokoll v2 mit signiertem Token je Anfrage;
 * ältere Desktop-Versionen (v0/v1) werden erkannt und im alten Format angesprochen.
 */
export class AmaranClient {
  private ws: WebSocket | null = null;
  private waiters = new Map<string, Waiter>();
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private seq = 0;
  /** ausgehandelte Protokollversion */
  protocol = 2;
  status: ConnectionStatus = { id: 'amaran', label: 'amaran Desktop', state: 'disabled' };

  constructor(
    private getSettings: () => Settings['amaran'],
    private onStatus: () => void,
    private envKey = '',
  ) {}

  private get apiKey(): string {
    return this.envKey || this.getSettings().apiKey || '';
  }

  private setStatus(state: ConnectionStatus['state'], detail?: string) {
    this.status = { ...this.status, state, detail };
    this.onStatus();
  }

  private okDetail(): string {
    return `${normalizeWsUrl(this.getSettings().url)} · Protokoll v${this.protocol}${this.apiKey ? ' · mit API-Key' : ''}`;
  }

  restart(): void {
    this.stop();
    const s = this.getSettings();
    if (!s.enabled) return this.setStatus('disabled');
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.rejectAll('amaran getrennt');
    this.setStatus('disabled');
  }

  private rejectAll(msg: string) {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new DriverError(msg));
    }
    this.waiters.clear();
  }

  private connect(): void {
    const s = this.getSettings();
    this.setStatus('connecting', s.url);
    this.protocol = 2;
    let ws: WebSocket;
    try {
      ws = new WebSocket(normalizeWsUrl(s.url), { handshakeTimeout: 5000 });
    } catch (err) {
      return this.setStatus('error', `Ungültige Adresse: ${(err as Error).message}`);
    }
    this.ws = ws;
    ws.on('open', async () => {
      this.setStatus('ok', this.okDetail());
      try {
        const v = (await this.request('get_protocol_versions', undefined, {}, 2000)) as Record<string, unknown> | unknown[];
        const list = (Array.isArray(v) ? v : ((v as Record<string, unknown>)?.versions as unknown[])) ?? [];
        const nums = list.map(Number).filter(Number.isFinite);
        if (nums.length && !nums.includes(2)) this.protocol = Math.max(...nums);
      } catch (err) {
        if (/token|auth|key|forbidden|unauthori/i.test((err as Error).message)) {
          return this.setStatus('error', `API-Key abgelehnt: ${(err as Error).message}`);
        }
        /* ältere Versionen kennen den Befehl nicht – Version kommt dann aus den Antworten */
      }
      this.setStatus('ok', this.okDetail());
    });
    ws.on('message', (buf) => {
      try {
        this.onMessage(buf.toString());
      } catch {
        /* unerwartete Nachricht der Desktop-App ignorieren */
      }
    });
    ws.on('close', () => {
      this.rejectAll('amaran getrennt');
      if (this.stopped) return;
      this.setStatus('connecting', 'Desktop-App nicht erreichbar – neuer Versuch in 10 s');
      this.retryTimer = setTimeout(() => this.connect(), 10_000);
    });
    ws.on('error', () => undefined);
  }

  private onMessage(raw: string): void {
    const msg = parseObject(raw);
    if (!msg) return;
    if (typeof msg.version === 'number' && msg.version < 2 && this.protocol >= 2) {
      this.protocol = msg.version;
      this.setStatus('ok', this.okDetail());
    }
    if (msg.type === 'event') return;
    const req = msg.request as Record<string, unknown> | undefined;
    const action = String(msg.action ?? req?.action ?? req?.type ?? (msg.type !== 'response' ? msg.type : '') ?? '');
    let key = typeof msg.request_id === 'string' && this.waiters.has(msg.request_id) ? msg.request_id : undefined;
    if (!key) for (const [k, w] of this.waiters) if (w.action === action) { key = k; break; }
    if (!key) return;
    const w = this.waiters.get(key)!;
    this.waiters.delete(key);
    clearTimeout(w.timer);
    if (Number(msg.code ?? 0) !== 0) w.reject(new DriverError(`amaran ${w.action}: ${msg.message ?? msg.msg ?? `Fehler ${msg.code}`}`));
    else w.resolve(msg.data);
  }

  request(action: string, nodeId?: string, args?: Record<string, unknown>, timeoutMs = 3000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new DriverError('amaran Desktop nicht verbunden'));
    const s = this.getSettings();
    const requestId = `uel-${++this.seq}`;
    const token = amaranToken(this.apiKey);
    const msg =
      this.protocol >= 2
        ? { version: 2, type: 'request', client_id: s.clientId, request_id: requestId, action, ...(nodeId ? { node_id: nodeId } : {}), args: args ?? {}, token }
        : { version: this.protocol, client_id: s.clientId, type: action, node_id: nodeId, args: args ?? {}, token };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new DriverError(`amaran ${action}: keine Antwort`));
      }, timeoutMs);
      this.waiters.set(requestId, { action, resolve, reject, timer });
      ws.send(JSON.stringify(msg));
    });
  }

  /** Geräte für den Einrichtungsdialog */
  async devices(): Promise<Array<{ nodeId: string; name: string }>> {
    const data = await this.request('get_device_list');
    const list = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.list as unknown[]) ?? ((data as Record<string, unknown>)?.devices as unknown[]) ?? [];
    return (list as Array<Record<string, unknown>>)
      .map((d) => ({
        nodeId: String(d.node_id ?? d.nodeId ?? d.id ?? ''),
        name: String(d.name ?? d.device_name ?? d.node_name ?? d.node_id ?? 'amaran'),
      }))
      .filter((d) => d.nodeId);
  }
}

function listFrom(data: unknown): Array<Record<string, unknown> | string | number> {
  if (Array.isArray(data)) return data;
  const o = data as Record<string, unknown>;
  for (const k of ['list', 'effects', 'presets', 'quickshots', 'scenes', 'items']) if (Array.isArray(o?.[k])) return o[k] as never;
  return [];
}

function itemId(it: Record<string, unknown> | string | number): string {
  if (typeof it !== 'object') return String(it);
  return String(it.effect_type ?? it.type ?? it.id ?? it.preset_id ?? it.quickshot_id ?? it.scene_id ?? it.name ?? '');
}

function itemName(it: Record<string, unknown> | string | number): string {
  if (typeof it !== 'object') return String(it);
  return String(it.name ?? it.title ?? it.effect_name ?? it.effect_type ?? it.id ?? 'Effekt');
}


/**
 * Bi-Color-Leuchten erkennen. amaran-Modellnamen: „…c“ = Vollfarbe (Pano 60C, 150c),
 * „…x“ = Bi-Color (Halo 60x, COB 60x S), „…d“ = Tageslicht; Verge-Panels sind Bi-Color.
 */
export function guessAmaranColor(name: string): 'rgb' | 'cct' | 'unknown' {
  const n = name.toLowerCase();
  if (/\bverge\b/.test(n)) return 'cct';
  if (/\b\d+\s*c\b|\bray\b|\bpixel\b|\bt[24]c\b|\bstar\s*c\b/.test(n)) return 'rgb';
  if (/\b\d+\s*[xd]\b|\b\d+[xd]\s*s\b|\bhalo\b/.test(n)) return 'cct';
  return 'unknown';
}

/** Farbe auf eine Farbtemperatur abbilden: Weiß → 5600 K, warme Farben bis 2700 K, kalte bis 6500 K */
export function rgbToCct(c: Rgb, min = 2700, max = 6500): number {
  const r = Math.max(0, Math.min(255, c.r)), b = Math.max(0, Math.min(255, c.b));
  const neutral = Math.min(max, Math.max(min, 5600));
  const k = r >= b ? neutral - ((r - b) / 255) * (neutral - min) : neutral + ((b - r) / 255) * (max - neutral);
  return Math.round(k / 50) * 50;
}

/** Eine amaran-/Aputure-Leuchte über die Desktop-App. */
export class AmaranDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: false, color: true, native: true };
  private awake: boolean | null = null;

  /** im Betrieb gelernt: Leuchte lehnt Farbbefehle ab */
  private learnedCct = false;

  constructor(readonly light: Light, private client: AmaranClient, private getSettings: () => Settings['amaran']) {}

  /** Vollfarbe oder nur Weiß? Einstellung am Licht, sonst Modellname, sonst Vollfarbe mit Rückfall */
  colorMode(): 'rgb' | 'cct' {
    const set = this.light.config.amaranColor ?? 'auto';
    if (set !== 'auto') return set;
    if (this.learnedCct) return 'cct';
    const guess = guessAmaranColor(`${this.light.config.deviceName ?? ''} ${this.light.name}`);
    return guess === 'cct' ? 'cct' : 'rgb';
  }

  private get node(): string {
    const n = this.light.config.nodeId;
    if (!n) throw new DriverError('Keine Node-ID für amaran hinterlegt');
    return n;
  }

  ledCount(): number {
    return 1;
  }

  private scaleIntensity(percent: number): number {
    return Math.round((Math.max(0, Math.min(100, percent)) / 100) * this.getSettings().intensityScale);
  }

  async probe() {
    try {
      const sleep = await this.client.request('get_sleep', this.node);
      const asleep = sleep === true || (sleep as Record<string, unknown>)?.sleep === true;
      const mode = this.colorMode() === 'cct' ? 'Bi-Color (Farben → Weißtöne)' : 'Vollfarbe';
      return { ok: true, detail: `Node ${this.node} · ${mode} · ${asleep ? 'Standby' : 'an'}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async snapshot(): Promise<unknown> {
    let sleep: unknown;
    try {
      sleep = await this.client.request('get_sleep', this.node);
    } catch {
      /* optional */
    }
    try {
      const cfg = (await this.client.request('get_node_config', this.node)) as Record<string, unknown>;
      return { cfg, sleep };
    } catch {
      // Protokoll v2 ohne get_node_config: Weiß und Helligkeit einzeln lesen
      const cfg: Record<string, unknown> = {};
      try {
        const i = (await this.client.request('get_intensity', this.node)) as Record<string, unknown>;
        cfg.intensity = i?.intensity ?? i;
      } catch {
        /* optional */
      }
      try {
        const c = (await this.client.request('get_cct', this.node)) as Record<string, unknown>;
        if (c?.cct !== undefined) cfg.cct = c.cct;
        if (c?.intensity !== undefined) cfg.intensity = c.intensity;
      } catch {
        /* optional */
      }
      return { cfg, sleep };
    }
  }

  async restore(raw: unknown): Promise<void> {
    const { cfg, sleep } = (raw ?? {}) as { cfg?: Record<string, unknown>; sleep?: unknown };
    if (!cfg) return;
    const sleeping =
      typeof sleep === 'boolean' ? sleep : (sleep as Record<string, unknown>)?.sleep === true || cfg.sleep === true;
    if (sleeping) return this.off();
    await this.wake();
    const intensity = Number(cfg.intensity ?? cfg.brightness);
    if (cfg.hue !== undefined && cfg.sat !== undefined) {
      await this.client.request('set_hsi', this.node, { hue: cfg.hue, sat: cfg.sat, intensity: Number.isFinite(intensity) ? intensity : undefined });
    } else if (cfg.cct !== undefined) {
      await this.client.request('set_cct', this.node, { cct: cfg.cct, intensity: Number.isFinite(intensity) ? intensity : undefined });
    } else if (Number.isFinite(intensity)) {
      await this.client.request('set_intensity', this.node, { intensity });
    }
  }

  private async wake(): Promise<void> {
    if (this.awake) return;
    await this.client.request('set_sleep', this.node, { sleep: false });
    this.awake = true;
  }

  async setColor(c: Rgb, brightness: number): Promise<void> {
    await this.wake();
    const intensity = this.scaleIntensity(brightness);
    if (this.colorMode() === 'cct') {
      await this.client.request('set_cct', this.node, { cct: rgbToCct(c), intensity });
      return;
    }
    const { h, s } = rgbToHsv(c);
    try {
      await this.client.request('set_hsi', this.node, { hue: Math.round(h), sat: Math.round(s * 100), intensity });
    } catch (err) {
      // Bi-Color-Leuchte, die Farbe ablehnt: ab jetzt Weißtöne schicken
      if ((this.light.config.amaranColor ?? 'auto') !== 'auto' || /nicht verbunden|keine Antwort|getrennt/.test((err as Error).message)) throw err;
      this.learnedCct = true;
      await this.client.request('set_cct', this.node, { cct: rgbToCct(c), intensity });
    }
  }

  async listNative(): Promise<NativeEffect[]> {
    const out: NativeEffect[] = [];
    try {
      const fx = await this.client.request('get_system_effect_list', this.node);
      for (const it of listFrom(fx)) out.push({ id: `effect:${itemId(it)}`, name: itemName(it), kind: 'effect', data: { effectType: itemId(it) } });
    } catch {
      /* nicht jede Leuchte hat Effekte */
    }
    try {
      const pr = await this.client.request('get_preset_list', this.node);
      for (const it of listFrom(pr)) out.push({ id: `preset:${itemId(it)}`, name: itemName(it), kind: 'preset', data: { presetId: itemId(it), raw: it } });
    } catch {
      /* optional */
    }
    try {
      const qs = await this.client.request('get_quickshot_list');
      for (const it of listFrom(qs)) {
        const id = typeof it === 'object' ? String(it.quickshot_id ?? it.id ?? itemId(it)) : String(it);
        out.push({ id: `quickshot:${id}`, name: itemName(it), kind: 'quickshot', data: { quickshotId: id } });
      }
    } catch {
      /* optional */
    }
    try {
      const sc = await this.client.request('get_scene_list');
      for (const it of listFrom(sc)) out.push({ id: `scene:${itemId(it)}`, name: itemName(it), kind: 'scene', data: { sceneId: itemId(it), raw: it } });
    } catch {
      /* optional */
    }
    return out;
  }

  async playNative(n: NativeEffect): Promise<void> {
    await this.wake();
    const s = this.getSettings();
    if (n.kind === 'effect') {
      await this.client.request('set_system_effect', this.node, { effect_type: n.data?.effectType });
    } else if (n.kind === 'preset') {
      await this.client.request(s.presetCommand, this.node, { preset_id: n.data?.presetId });
    } else if (n.kind === 'quickshot') {
      await this.client.request('set_quickshot', undefined, { quickshot_id: n.data?.quickshotId });
    } else if (n.kind === 'scene') {
      await this.client.request(s.sceneCommand, undefined, { scene_id: n.data?.sceneId });
    }
  }

  async off(): Promise<void> {
    await this.client.request('set_sleep', this.node, { sleep: true });
    this.awake = false;
  }
}
