import WebSocket from 'ws';
import type { ConnectionStatus, Light, NativeEffect, Rgb, Settings } from '@uelights/shared';
import { DriverError, parseObject, type DriverCapabilities, type LightDriver } from './types.js';

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** Eine WebSocket-Verbindung zu Home Assistant (lokal, Long-Lived Access Token). */
export class HomeAssistantClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  states = new Map<string, HaState>();
  status: ConnectionStatus = { id: 'homeassistant', label: 'Home Assistant', state: 'disabled' };

  constructor(
    private getSettings: () => Settings['homeassistant'],
    private tokenOverride: string,
    private onStatus: () => void,
  ) {}

  private setStatus(state: ConnectionStatus['state'], detail?: string) {
    this.status = { ...this.status, state, detail };
    this.onStatus();
  }

  restart(): void {
    this.stop();
    const s = this.getSettings();
    if (!s.enabled) return this.setStatus('disabled');
    if (!(this.tokenOverride || s.token)) return this.setStatus('error', 'Kein Access Token hinterlegt');
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

  private wsUrl(): string {
    const u = this.getSettings().url.replace(/\/+$/, '');
    return u.replace(/^http/, 'ws') + '/api/websocket';
  }

  private connect(): void {
    const s = this.getSettings();
    this.setStatus('connecting', s.url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl(), { handshakeTimeout: 5000 });
    } catch (err) {
      return this.setStatus('error', `Ungültige Adresse: ${(err as Error).message}`);
    }
    this.ws = ws;
    ws.on('message', async (buf) => {
      const msg = parseObject(buf.toString());
      if (!msg) return;
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.tokenOverride || s.token }));
      } else if (msg.type === 'auth_invalid') {
        this.setStatus('error', 'Token ungültig');
        this.stopped = true;
        ws.close();
      } else if (msg.type === 'auth_ok') {
        try {
          const states = (await this.send({ type: 'get_states' })) as HaState[];
          this.states.clear();
          for (const st of states) this.states.set(st.entity_id, st);
          await this.send({ type: 'subscribe_events', event_type: 'state_changed' });
          this.setStatus('ok', `${s.url} · ${this.states.size} Entitäten`);
        } catch (err) {
          this.setStatus('error', (err as Error).message);
        }
      } else if (msg.type === 'event') {
        const ev = msg.event as { data?: { entity_id?: string; new_state?: HaState | null } };
        const id = ev?.data?.entity_id;
        if (id) {
          if (ev.data?.new_state) this.states.set(id, ev.data.new_state);
          else this.states.delete(id);
        }
      } else if (msg.type === 'result') {
        const p = this.pending.get(Number(msg.id));
        if (!p) return;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new DriverError(`Home Assistant: ${(msg.error as Record<string, unknown>)?.message ?? 'Fehler'}`));
      }
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new DriverError('Home Assistant getrennt'));
      this.pending.clear();
      if (this.stopped) return;
      this.setStatus('connecting', 'Verbindung getrennt – neuer Versuch in 10 s');
      this.retryTimer = setTimeout(() => this.connect(), 10_000);
    });
    ws.on('error', () => undefined);
  }

  send(payload: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new DriverError('Home Assistant nicht verbunden'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverError('Home Assistant: Zeitüberschreitung'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  callService(domain: string, service: string, entityId: string, data: Record<string, unknown> = {}): Promise<unknown> {
    return this.send({ type: 'call_service', domain, service, service_data: data, target: { entity_id: entityId } });
  }

  /** Steuerbare Entitäten für den Einrichtungsdialog */
  entities(): Array<{ entityId: string; name: string; effects: number }> {
    return [...this.states.values()]
      .filter((s) => /^(light|scene|script)\./.test(s.entity_id))
      .map((s) => ({
        entityId: s.entity_id,
        name: String(s.attributes.friendly_name ?? s.entity_id),
        effects: Array.isArray(s.attributes.effect_list) ? s.attributes.effect_list.length : 0,
      }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
  }
}

export class HomeAssistantDriver implements LightDriver {
  readonly capabilities: DriverCapabilities;

  constructor(readonly light: Light, private ha: HomeAssistantClient) {
    const isLight = this.entity.startsWith('light.');
    this.capabilities = { realtime: false, color: isLight, native: true };
  }

  private get entity(): string {
    const e = this.light.config.entityId;
    if (!e) throw new DriverError('Keine Entität für Home Assistant hinterlegt');
    return e;
  }

  private get domain(): string {
    return this.entity.split('.')[0];
  }

  ledCount(): number {
    return 1;
  }

  async probe() {
    const st = this.ha.states.get(this.entity);
    if (!st) return { ok: false, detail: `${this.entity} nicht gefunden (Home Assistant verbunden?)` };
    return { ok: true, detail: `${st.attributes.friendly_name ?? this.entity} · ${st.state}` };
  }

  async snapshot(): Promise<HaState | undefined> {
    const st = this.ha.states.get(this.entity);
    return st ? structuredClone(st) : undefined;
  }

  async restore(raw: unknown): Promise<void> {
    const st = raw as HaState | undefined;
    if (!st || this.domain !== 'light') return;
    if (st.state !== 'on') {
      await this.ha.callService('light', 'turn_off', this.entity);
      return;
    }
    const a = st.attributes;
    const data: Record<string, unknown> = {};
    if (typeof a.brightness === 'number') data.brightness = a.brightness;
    if (a.effect && a.effect !== 'None') data.effect = a.effect;
    else if (a.color_mode === 'color_temp' && a.color_temp_kelvin) data.color_temp_kelvin = a.color_temp_kelvin;
    else if (Array.isArray(a.rgb_color)) data.rgb_color = a.rgb_color;
    await this.ha.callService('light', 'turn_on', this.entity, data);
  }

  async setColor(c: Rgb, brightness: number): Promise<void> {
    if (this.domain !== 'light') return;
    await this.ha.callService('light', 'turn_on', this.entity, {
      rgb_color: [Math.round(c.r), Math.round(c.g), Math.round(c.b)],
      brightness_pct: Math.max(1, Math.round(brightness)),
      transition: 0,
    });
  }

  async listNative(): Promise<NativeEffect[]> {
    const st = this.ha.states.get(this.entity);
    if (this.domain === 'scene' || this.domain === 'script') {
      return [{ id: 'activate', name: `${st?.attributes.friendly_name ?? this.entity} aktivieren`, kind: this.domain }];
    }
    const list = (st?.attributes.effect_list as string[] | undefined) ?? [];
    return list.map((e) => ({ id: `effect:${e}`, name: e, kind: 'ha-effect', data: { effect: e } }));
  }

  async playNative(n: NativeEffect): Promise<void> {
    if (n.kind === 'scene') await this.ha.callService('scene', 'turn_on', this.entity);
    else if (n.kind === 'script') await this.ha.callService('script', 'turn_on', this.entity);
    else await this.ha.callService('light', 'turn_on', this.entity, { effect: n.data?.effect });
  }

  async off(): Promise<void> {
    if (this.domain === 'light') await this.ha.callService('light', 'turn_off', this.entity);
  }
}
