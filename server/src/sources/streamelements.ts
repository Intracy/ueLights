import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { ConnectionStatus, Settings } from '@uelights/shared';
import { parseObject } from '../connectors/types.js';
import { normalizeActivity, normalizeChat, normalizeTip, type NormalizeResult } from '../events/normalize.js';

const ASTRO_URL = 'wss://astro.streamelements.com';

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/** Liest die Kanal-ID aus dem StreamElements-JWT (Feld "channel"). */
export function channelIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.channel === 'string' ? json.channel : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Client für das StreamElements-Astro-Gateway.
 * Einzige Verbindung der App nach außen; wird vom Server aus aufgebaut (keine Portfreigabe nötig).
 */
export class StreamElementsSource {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  status: ConnectionStatus = { id: 'streamelements', label: 'StreamElements', state: 'disabled' };

  constructor(
    private getSettings: () => Settings,
    private jwtOverride: string,
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
    const s = this.getSettings().streamelements;
    const jwt = this.jwtOverride || s.jwt;
    if (!s.enabled) return this.setStatus('disabled');
    if (!jwt) return this.setStatus('error', 'Kein JWT-Token hinterlegt');
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        /* egal */
      }
    }
    this.ws = null;
    this.setStatus('disabled');
  }

  private connect(): void {
    const s = this.getSettings();
    const jwt = this.jwtOverride || s.streamelements.jwt;
    const room = s.streamelements.channelId || channelIdFromJwt(jwt);
    if (!room) return this.setStatus('error', 'Kanal-ID fehlt (nicht im Token gefunden)');

    this.setStatus('connecting');
    const ws = new WebSocket(ASTRO_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      const topics: string[] = [];
      if (s.streamelements.topics.activities) topics.push('channel.activities');
      if (s.streamelements.topics.tips) topics.push('channel.tips');
      if (s.streamelements.topics.chat) topics.push('channel.chat.message');
      for (const topic of topics) {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            nonce: crypto.randomUUID(),
            data: { topic, room, token: jwt, token_type: 'jwt' },
          }),
        );
      }
      this.setStatus('ok', `Kanal ${room.slice(0, 6)}… · ${topics.length} Topics`);
      this.log.info({ topics }, 'StreamElements verbunden');
    });

    ws.on('message', (buf) => {
      const msg = parseObject(buf.toString());
      if (!msg) return;
      if (msg.type === 'response' && msg.error) {
        this.log.warn(msg, 'StreamElements-Fehler');
        this.setStatus('error', String(msg.error));
        return;
      }
      if (msg.type === 'reconnect') {
        ws.close();
        return;
      }
      if (msg.type !== 'message') return;
      const s2 = this.getSettings().events;
      let res: NormalizeResult | null = null;
      if (msg.topic === 'channel.activities') res = normalizeActivity(msg, s2);
      else if (msg.topic === 'channel.tips') res = normalizeTip(msg, s2);
      else if (msg.topic === 'channel.chat.message') res = normalizeChat(msg);
      if (res) this.onEvent(res);
    });

    ws.on('close', (code) => {
      if (this.stopped) return;
      this.scheduleReconnect(`Verbindung getrennt (${code})`);
    });
    ws.on('error', (err) => {
      this.log.warn({ err: err.message }, 'StreamElements-Verbindungsfehler');
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.retry++);
    this.setStatus('connecting', `${reason} – neuer Versuch in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
