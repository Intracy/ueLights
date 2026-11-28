import WebSocket from 'ws';
import type { ConnectionStatus, NormalizedEvent, Settings } from '@uelights/shared';
import { parseObject } from '../connectors/types.js';
import type { NormalizeResult } from '../events/normalize.js';

/**
 * Twitch direkt: Anmeldung per Geräte-Code (kein Client-Secret, keine Weiterleitungs-Adresse),
 * Events über EventSub per WebSocket (ausgehende Verbindung, keine Portfreigabe).
 */

export const TWITCH_SCOPES = ['channel:read:redemptions', 'bits:read', 'moderator:read:followers', 'channel:read:subscriptions'];

export interface TwitchUrls {
  id: string;
  helix: string;
  eventsub: string;
}
const DEFAULT_URLS: TwitchUrls = {
  id: 'https://id.twitch.tv/oauth2',
  helix: 'https://api.twitch.tv/helix',
  eventsub: 'wss://eventsub.wss.twitch.tv/ws',
};

type Obj = Record<string, unknown>;
type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

// ------------------------------------------------------------ Events

const TIER: Record<string, string> = { '1000': '1000', '2000': '2000', '3000': '3000', prime: 'prime' };

/** EventSub-Benachrichtigung in ein ueLights-Event übersetzen */
export function normalizeTwitch(type: string, e: Obj, messageId: string, ts?: string): NormalizeResult | null {
  const base = {
    id: `tw-${messageId}`,
    source: 'twitch' as const,
    rawType: type,
    provider: 'twitch',
    isTest: false,
    ts: ts ?? new Date().toISOString(),
    raw: e,
  };
  const user = str(e.user_name) ?? str(e.user_login);
  switch (type) {
    case 'channel.channel_points_custom_reward_redemption.add': {
      const reward = obj(e.reward);
      return {
        event: { ...base, type: 'channelPoints', user, amount: num(reward.cost), reward: str(reward.title), message: str(e.user_input) },
      };
    }
    case 'channel.cheer':
      return {
        event: { ...base, type: 'cheer', user: e.is_anonymous ? 'Anonym' : user, amount: num(e.bits), message: str(e.message) },
      };
    case 'channel.follow':
      return { event: { ...base, type: 'follow', user } };
    case 'channel.subscribe': {
      // Geschenkte Subs kommen zusätzlich als channel.subscription.gift; die Einzel-Subs davon nicht doppelt zählen
      const gifted = e.is_gift === true;
      return {
        event: { ...base, type: 'subscriber', user, amount: 1, subTier: TIER[String(e.tier)] },
        skipReason: gifted ? 'Geschenkter Sub (zählt über das Gift-Event)' : undefined,
      };
    }
    case 'channel.subscription.message':
      return {
        event: {
          ...base,
          type: 'subscriber',
          user,
          amount: num(e.cumulative_months) ?? 1,
          subTier: TIER[String(e.tier)],
          message: str(obj(e.message).text),
        },
      };
    case 'channel.subscription.gift':
      return {
        event: { ...base, type: 'giftSub', user: e.is_anonymous ? 'Anonym' : user, amount: num(e.total) ?? 1, subTier: TIER[String(e.tier)] },
      };
    case 'channel.raid':
      return {
        event: { ...base, type: 'raid', user: str(e.from_broadcaster_user_name), amount: num(e.viewers) },
      };
    default:
      return null;
  }
}

// ------------------------------------------------------------ Anmeldung

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export class TwitchError extends Error {}

/** Anmeldung, Token-Erneuerung und Helix-Aufrufe */
export class TwitchAuth {
  pending: (DeviceLogin & { deviceCode: string; interval: number }) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  lastError = '';

  constructor(
    private getSettings: () => Settings['twitch'],
    private saveSettings: (patch: Partial<Settings['twitch']>) => void,
    private onChange: () => void,
    readonly urls: TwitchUrls = DEFAULT_URLS,
  ) {}

  private async form(url: string, body: Record<string, string>): Promise<{ status: number; json: Obj }> {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const json = obj(await r.json().catch(() => ({})));
    return { status: r.status, json };
  }

  /** Schritt 1: Code anfordern, den der Nutzer auf twitch.tv/activate eingibt */
  async startDeviceLogin(): Promise<DeviceLogin> {
    const s = this.getSettings();
    if (!s.clientId) throw new TwitchError('Erst die Client-ID eintragen und speichern');
    this.cancel();
    const { status, json } = await this.form(`${this.urls.id}/device`, { client_id: s.clientId, scopes: TWITCH_SCOPES.join(' ') });
    if (status >= 400 || !json.device_code) throw new TwitchError(`Twitch: ${str(json.message) ?? `HTTP ${status}`}`);
    this.pending = {
      deviceCode: String(json.device_code),
      userCode: String(json.user_code),
      verificationUri: String(json.verification_uri ?? 'https://www.twitch.tv/activate'),
      interval: Math.max(1, Number(json.interval ?? 5)),
      expiresAt: Date.now() + Number(json.expires_in ?? 1800) * 1000,
    };
    this.lastError = '';
    this.schedulePoll();
    this.onChange();
    const { deviceCode: _d, interval: _i, ...pub } = this.pending;
    return pub;
  }

  cancel(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
  }

  private schedulePoll(): void {
    if (!this.pending) return;
    this.pollTimer = setTimeout(() => this.poll().catch(() => undefined), this.pending.interval * 1000);
  }

  /** Schritt 2: warten, bis der Nutzer bestätigt hat */
  async poll(): Promise<boolean> {
    const p = this.pending;
    if (!p) return false;
    if (Date.now() > p.expiresAt) {
      this.cancel();
      this.lastError = 'Code abgelaufen – bitte neu anmelden';
      this.onChange();
      return false;
    }
    const s = this.getSettings();
    const { status, json } = await this.form(`${this.urls.id}/token`, {
      client_id: s.clientId,
      scopes: TWITCH_SCOPES.join(' '),
      device_code: p.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (status === 200 && json.access_token) {
      this.cancel();
      await this.store(json);
      return true;
    }
    const msg = str(json.message) ?? '';
    if (/authorization_pending/i.test(msg) || /slow_down/i.test(msg)) {
      if (/slow_down/i.test(msg)) p.interval += 5;
      this.schedulePoll();
      return false;
    }
    this.cancel();
    this.lastError = /denied/i.test(msg) ? 'Anmeldung abgelehnt' : `Anmeldung fehlgeschlagen: ${msg || `HTTP ${status}`}`;
    this.onChange();
    return false;
  }

  /** Token speichern und Konto ermitteln */
  private async store(json: Obj): Promise<void> {
    const access = String(json.access_token);
    const v = await fetch(`${this.urls.id}/validate`, { headers: { Authorization: `OAuth ${access}` } });
    const info = obj(await v.json().catch(() => ({})));
    if (v.status >= 400 || !info.user_id) throw new TwitchError('Twitch-Token ungültig');
    this.saveSettings({
      accessToken: access,
      refreshToken: str(json.refresh_token) ?? '',
      expiresAt: Date.now() + Number(json.expires_in ?? info.expires_in ?? 3600) * 1000,
      userId: String(info.user_id),
      login: String(info.login ?? ''),
      scopes: Array.isArray(info.scopes) ? info.scopes.map(String) : TWITCH_SCOPES,
      enabled: true,
    });
    this.lastError = '';
    this.onChange();
  }

  /** Token erneuern (öffentliche Clients: Refresh-Token ist einmalig und 30 Tage gültig) */
  async refresh(): Promise<void> {
    const s = this.getSettings();
    if (!s.refreshToken) throw new TwitchError('Anmeldung abgelaufen – bitte neu mit Twitch anmelden');
    const { status, json } = await this.form(`${this.urls.id}/token`, {
      client_id: s.clientId,
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken,
    });
    if (status >= 400 || !json.access_token) {
      this.saveSettings({ accessToken: '', refreshToken: '' });
      throw new TwitchError('Anmeldung abgelaufen – bitte neu mit Twitch anmelden');
    }
    await this.store(json);
  }

  async token(): Promise<string> {
    const s = this.getSettings();
    if (!s.accessToken) throw new TwitchError('Nicht mit Twitch angemeldet');
    if (Date.now() > s.expiresAt - 5 * 60_000) await this.refresh();
    return this.getSettings().accessToken;
  }

  /** Helix-Aufruf mit automatischer Token-Erneuerung */
  async helix(method: string, path: string, body?: unknown, retried = false): Promise<Obj> {
    const token = await this.token();
    const r = await fetch(`${this.urls.helix}${path}`, {
      method,
      headers: {
        'Client-Id': this.getSettings().clientId,
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = obj(await r.json().catch(() => ({})));
    if (r.status === 401 && !retried) {
      await this.refresh();
      return this.helix(method, path, body, true);
    }
    if (r.status >= 400) throw new TwitchError(`Twitch ${path.split('?')[0]}: ${str(json.message) ?? `HTTP ${r.status}`}`);
    return json;
  }

  logout(): void {
    this.cancel();
    this.saveSettings({ accessToken: '', refreshToken: '', userId: '', login: '', scopes: [], expiresAt: 0 });
    this.onChange();
  }
}

// ------------------------------------------------------------ EventSub

const SUBSCRIPTIONS: Array<{ key: keyof Settings['twitch']['events']; type: string; version: string; condition: (uid: string) => Obj }> = [
  { key: 'channelPoints', type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: (u) => ({ broadcaster_user_id: u }) },
  { key: 'cheer', type: 'channel.cheer', version: '1', condition: (u) => ({ broadcaster_user_id: u }) },
  { key: 'follow', type: 'channel.follow', version: '2', condition: (u) => ({ broadcaster_user_id: u, moderator_user_id: u }) },
  { key: 'subs', type: 'channel.subscribe', version: '1', condition: (u) => ({ broadcaster_user_id: u }) },
  { key: 'subs', type: 'channel.subscription.message', version: '1', condition: (u) => ({ broadcaster_user_id: u }) },
  { key: 'subs', type: 'channel.subscription.gift', version: '1', condition: (u) => ({ broadcaster_user_id: u }) },
  { key: 'raid', type: 'channel.raid', version: '1', condition: (u) => ({ to_broadcaster_user_id: u }) },
];

export class TwitchSource {
  status: ConnectionStatus = { id: 'twitch', label: 'Twitch', state: 'disabled' };
  private ws: WebSocket | null = null;
  private stopped = true;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private keepaliveMs = 15_000;
  private seen = new Set<string>();

  constructor(
    private getSettings: () => Settings['twitch'],
    readonly auth: TwitchAuth,
    private onEvent: (res: NormalizeResult) => void,
    private onStatus: () => void,
    private log: Logger,
  ) {}

  private setStatus(state: ConnectionStatus['state'], detail?: string) {
    this.status = { ...this.status, state, detail };
    this.onStatus();
  }

  restart(): void {
    this.stop();
    const s = this.getSettings();
    if (!s.enabled) return this.setStatus('disabled');
    if (!s.clientId) return this.setStatus('error', 'Client-ID fehlt');
    if (!s.accessToken) return this.setStatus('error', 'Nicht angemeldet – „Mit Twitch anmelden“');
    this.stopped = false;
    this.connect(this.auth.urls.eventsub);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.keepalive) clearTimeout(this.keepalive);
    this.timer = this.keepalive = null;
    this.close(this.ws);
    this.ws = null;
    this.setStatus('disabled');
  }

  private close(ws: WebSocket | null) {
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => undefined);
    try {
      ws.close();
    } catch {
      /* egal */
    }
  }

  private armKeepalive() {
    if (this.keepalive) clearTimeout(this.keepalive);
    this.keepalive = setTimeout(() => {
      this.log.warn({}, 'Twitch EventSub: Keepalive fehlt, verbinde neu');
      this.reconnectLater();
    }, this.keepaliveMs + 5000);
  }

  private reconnectLater() {
    if (this.stopped) return;
    this.close(this.ws);
    this.ws = null;
    const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
    this.setStatus('connecting', `Verbindung getrennt – neuer Versuch in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => this.connect(this.auth.urls.eventsub), delay);
  }

  /** @param reconnect true bei session_reconnect: Abos bleiben bestehen */
  private connect(url: string, reconnect = false): void {
    if (!reconnect) this.setStatus('connecting', 'EventSub');
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const previous = reconnect ? this.ws : null;
    if (!reconnect) this.ws = ws;
    ws.on('message', (buf) => {
      try {
        this.onMessage(ws, buf.toString(), previous);
      } catch (err) {
        this.log.warn({ err }, 'Twitch-Nachricht nicht verarbeitet');
      }
    });
    ws.on('close', () => {
      if (ws === this.ws) this.reconnectLater();
    });
    ws.on('error', () => undefined);
  }

  private onMessage(ws: WebSocket, raw: string, previous: WebSocket | null) {
    const msg = parseObject(raw);
    if (!msg) return;
    const meta = obj(msg.metadata);
    const payload = obj(msg.payload);
    const type = str(meta.message_type);
    if (type !== 'session_keepalive' && type !== 'notification' && type !== 'session_welcome') this.log.info({ type }, 'Twitch EventSub');
    if (ws === this.ws) this.armKeepalive();

    if (type === 'session_welcome') {
      const session = obj(payload.session);
      this.keepaliveMs = Number(session.keepalive_timeout_seconds ?? 10) * 1000;
      if (previous) {
        // Wechsel nach session_reconnect: alte Verbindung schließen, Abos bleiben
        this.ws = ws;
        this.close(previous);
        this.armKeepalive();
        return;
      }
      this.subscribe(String(session.id)).catch((err) => {
        this.setStatus('error', (err as Error).message);
        this.log.warn({ err }, 'Twitch-Abos fehlgeschlagen');
      });
      return;
    }
    if (type === 'session_reconnect') {
      const url = str(obj(payload.session).reconnect_url);
      if (url) this.connect(url, true);
      return;
    }
    if (type === 'revocation') {
      const sub = obj(payload.subscription);
      this.setStatus('error', `Twitch hat ${str(sub.type)} beendet (${str(sub.status)}) – neu anmelden`);
      return;
    }
    if (type === 'notification') {
      const id = String(meta.message_id ?? '');
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
      const sub = obj(payload.subscription);
      const res = normalizeTwitch(String(sub.type), obj(payload.event), id, str(meta.message_timestamp));
      if (res) this.onEvent(res);
    }
  }

  private async subscribe(sessionId: string) {
    const s = this.getSettings();
    const uid = s.userId;
    const wanted = SUBSCRIPTIONS.filter((x) => s.events[x.key]);
    const failed: string[] = [];
    for (const sub of wanted) {
      try {
        await this.auth.helix('POST', '/eventsub/subscriptions', {
          type: sub.type,
          version: sub.version,
          condition: sub.condition(uid),
          transport: { method: 'websocket', session_id: sessionId },
        });
      } catch (err) {
        failed.push(`${sub.type}: ${(err as Error).message}`);
      }
    }
    this.retry = 0;
    if (failed.length && failed.length === wanted.length) throw new Error(failed[0]);
    const ok = wanted.length - failed.length;
    this.setStatus(
      failed.length ? 'error' : 'ok',
      `${s.login || 'Kanal'} · ${ok} Event-Arten${failed.length ? ` · ${failed.length} abgelehnt (${failed[0]})` : ''}`,
    );
  }

  /** Kanalpunkte-Belohnungen des Kanals (Name und Kosten) */
  async rewards(): Promise<Array<{ id: string; title: string; cost: number; enabled: boolean }>> {
    const s = this.getSettings();
    const r = await this.auth.helix('GET', `/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(s.userId)}`);
    const list = Array.isArray(r.data) ? (r.data as Obj[]) : [];
    return list
      .map((x) => ({ id: String(x.id), title: String(x.title ?? ''), cost: Number(x.cost ?? 0), enabled: x.is_enabled !== false }))
      .sort((a, b) => a.cost - b.cost);
  }
}

export type { NormalizedEvent };
