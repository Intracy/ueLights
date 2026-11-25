import WebSocket from 'ws';
import { rgbToHsv, type ConnectionStatus, type Light, type NativeEffect, type Rgb, type Settings } from '@uelights/shared';
import { DriverError, type DriverCapabilities, type LightDriver } from './types.js';

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Verbindung zur amaran-Desktop-App (WebSocket, Standard-Port 33782).
 * Die App hält die Bluetooth-Verbindung zu den Leuchten.
 */
export class AmaranClient {
  private ws: WebSocket | null = null;
  private waiters = new Map<string, Waiter[]>();
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  status: ConnectionStatus = { id: 'amaran', label: 'amaran Desktop', state: 'disabled' };

  constructor(private getSettings: () => Settings['amaran'], private onStatus: () => void) {}

  private setStatus(state: ConnectionStatus['state'], detail?: string) {
    this.status = { ...this.status, state, detail };
    this.onStatus();
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
    this.setStatus('disabled');
  }

  private connect(): void {
    const s = this.getSettings();
    this.setStatus('connecting', s.url);
    const ws = new WebSocket(s.url);
    this.ws = ws;
    ws.on('open', () => this.setStatus('ok', s.url));
    ws.on('message', (buf) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      const req = msg.request as Record<string, unknown> | undefined;
      const type = String(req?.type ?? msg.type ?? '');
      const w = this.waiters.get(type)?.shift();
      if (!w) return;
      clearTimeout(w.timer);
      if (Number(msg.code ?? 0) !== 0) w.reject(new DriverError(`amaran ${type}: ${msg.message ?? msg.code}`));
      else w.resolve(msg.data);
    });
    ws.on('close', () => {
      for (const list of this.waiters.values()) for (const w of list) w.reject(new DriverError('amaran getrennt'));
      this.waiters.clear();
      if (this.stopped) return;
      this.setStatus('connecting', 'Desktop-App nicht erreichbar – neuer Versuch in 10 s');
      this.retryTimer = setTimeout(() => this.connect(), 10_000);
    });
    ws.on('error', () => undefined);
  }

  request(type: string, nodeId?: string, args?: Record<string, unknown>, timeoutMs = 3000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new DriverError('amaran Desktop nicht verbunden'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(type) ?? [];
        this.waiters.set(type, list.filter((x) => x.timer !== timer));
        reject(new DriverError(`amaran ${type}: keine Antwort`));
      }, timeoutMs);
      const list = this.waiters.get(type) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(type, list);
      ws.send(JSON.stringify({ version: 1, client_id: this.getSettings().clientId, type, node_id: nodeId, args: args ?? {} }));
    });
  }

  /** Geräte für den Einrichtungsdialog */
  async devices(): Promise<Array<{ nodeId: string; name: string }>> {
    const data = await this.request('get_device_list');
    const list = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.list as unknown[]) ?? [];
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
  for (const k of ['list', 'effects', 'presets', 'scenes', 'items']) if (Array.isArray(o?.[k])) return o[k] as never;
  return [];
}

function itemId(it: Record<string, unknown> | string | number): string {
  if (typeof it !== 'object') return String(it);
  return String(it.effect_type ?? it.type ?? it.id ?? it.preset_id ?? it.scene_id ?? it.name ?? '');
}

function itemName(it: Record<string, unknown> | string | number): string {
  if (typeof it !== 'object') return String(it);
  return String(it.name ?? it.title ?? it.effect_name ?? it.effect_type ?? it.id ?? 'Effekt');
}

/** Eine amaran-/Aputure-Leuchte über die Desktop-App. */
export class AmaranDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: false, color: true, native: true };
  private awake: boolean | null = null;

  constructor(readonly light: Light, private client: AmaranClient, private getSettings: () => Settings['amaran']) {}

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
      await this.client.request('get_node_config', this.node);
      return { ok: true, detail: `Node ${this.node}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async snapshot(): Promise<unknown> {
    const cfg = (await this.client.request('get_node_config', this.node)) as Record<string, unknown>;
    let sleep: unknown;
    try {
      sleep = await this.client.request('get_sleep', this.node);
    } catch {
      /* optional */
    }
    return { cfg, sleep };
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
    const { h, s } = rgbToHsv(c);
    await this.client.request('set_hsi', this.node, {
      hue: Math.round(h),
      sat: Math.round(s * 100),
      intensity: this.scaleIntensity(brightness),
    });
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
    } else if (n.kind === 'scene') {
      await this.client.request(s.sceneCommand, undefined, { scene_id: n.data?.sceneId });
    }
  }

  async off(): Promise<void> {
    await this.client.request('set_sleep', this.node, { sleep: true });
    this.awake = false;
  }
}
