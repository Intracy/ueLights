import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@uelights/shared';
import { EventPipeline } from '../src/events/pipeline.js';
import type { NormalizeResult } from '../src/events/normalize.js';
import { normalizeTwitch, TwitchAuth, TwitchSource } from '../src/sources/twitch.js';

const quiet = { info: () => undefined, warn: () => undefined };

describe('Twitch-Events', () => {
  it('liest Kanalpunkte mit Belohnung, Kosten und Text', () => {
    const r = normalizeTwitch(
      'channel.channel_points_custom_reward_redemption.add',
      { user_name: 'Huebi', user_input: 'blau', reward: { id: 'r1', title: 'Licht an', cost: 500 } },
      'm1',
    )!;
    expect(r.event).toMatchObject({ type: 'channelPoints', source: 'twitch', user: 'Huebi', amount: 500, reward: 'Licht an', message: 'blau' });
  });

  it('liest Bits, Gift-Subs, Resubs und Raids', () => {
    expect(normalizeTwitch('channel.cheer', { user_name: 'a', bits: 250, is_anonymous: false }, 'x')!.event).toMatchObject({ type: 'cheer', amount: 250 });
    expect(normalizeTwitch('channel.subscription.gift', { user_name: 'b', total: 10, tier: '1000' }, 'y')!.event).toMatchObject({ type: 'giftSub', amount: 10, subTier: '1000' });
    expect(normalizeTwitch('channel.subscription.message', { user_name: 'c', cumulative_months: 14, tier: '2000', message: { text: 'hi' } }, 'z')!.event).toMatchObject({
      type: 'subscriber',
      amount: 14,
      message: 'hi',
    });
    expect(normalizeTwitch('channel.raid', { from_broadcaster_user_name: 'd', viewers: 42 }, 'w')!.event).toMatchObject({ type: 'raid', user: 'd', amount: 42 });
    expect(normalizeTwitch('channel.subscribe', { user_name: 'e', is_gift: true, tier: '1000' }, 'v')!.skipReason).toMatch(/Geschenkter/);
  });

  it('löst dasselbe Ereignis aus StreamElements und Twitch nur einmal aus', () => {
    const p = new EventPipeline(() => 5000);
    const tw = normalizeTwitch('channel.cheer', { user_name: 'Huebi', bits: 100 }, 'a1')!;
    const se: NormalizeResult = { event: { ...tw.event, id: 'se-1', source: 'streamelements', user: 'huebi' } };
    expect(p.process(tw, 1000).drop).toBeUndefined();
    expect(p.process(se, 3000).drop).toMatch(/Schon über Twitch/);
    // Später erneut: neues Ereignis
    expect(p.process({ event: { ...se.event, id: 'se-2' } }, 30_000).drop).toBeUndefined();
  });
});

// ------------------------------------------------------------ Nachgebautes Twitch
let httpSrv: http.Server;
let wss: WebSocketServer;
let base = '';
let wsUrl = '';
const state = { approved: false, tokenCalls: 0, refreshCalls: 0, subs: [] as Array<Record<string, unknown>>, sockets: [] as WebSocket[], expiresIn: 14400 };

beforeAll(async () => {
  httpSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, o: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? '';
      const form = new URLSearchParams(body);
      if (url === '/oauth2/device') return send(200, { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH', expires_in: 1800, interval: 1 });
      if (url === '/oauth2/token') {
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshCalls++;
          return send(200, { access_token: 'ACCESS2', refresh_token: 'REFRESH2', expires_in: 14400 });
        }
        state.tokenCalls++;
        if (!state.approved) return send(400, { status: 400, message: 'authorization_pending' });
        return send(200, { access_token: 'ACCESS1', refresh_token: 'REFRESH1', expires_in: state.expiresIn });
      }
      if (url === '/oauth2/validate') return send(200, { client_id: 'CID', login: 'tobias', user_id: '4711', scopes: ['channel:read:redemptions'], expires_in: 14400 });
      if (req.headers['client-id'] !== 'CID' || !String(req.headers.authorization).startsWith('Bearer ACCESS')) return send(401, { message: 'invalid token' });
      if (url === '/helix/eventsub/subscriptions' && req.method === 'POST') {
        state.subs.push(JSON.parse(body));
        return send(202, { data: [{ id: 'sub' }] });
      }
      if (url.startsWith('/helix/channel_points/custom_rewards')) {
        return send(200, { data: [{ id: 'r2', title: 'Disco', cost: 5000, is_enabled: true }, { id: 'r1', title: 'Licht an', cost: 500, is_enabled: true }] });
      }
      send(404, { message: 'nope' });
    });
  });
  await new Promise<void>((r) => httpSrv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(httpSrv.address() as { port: number }).port}`;
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  wsUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ws`;
  wss.on('connection', (ws, req) => {
    state.sockets.push(ws);
    const session = req.url?.includes('reconnect') ? 'S2' : 'S1';
    ws.send(JSON.stringify({ metadata: { message_id: `w-${session}`, message_type: 'session_welcome' }, payload: { session: { id: session, keepalive_timeout_seconds: 10 } } }));
  });
});
afterAll(() => {
  httpSrv.close();
  wss.close();
});

describe('Twitch-Anmeldung und EventSub', () => {
  let tw: Settings['twitch'] = { ...DEFAULT_SETTINGS.twitch, clientId: 'CID' };
  const urls = () => ({ id: `${base}/oauth2`, helix: `${base}/helix`, eventsub: wsUrl });
  const auth = () => new TwitchAuth(() => tw, (p) => (tw = { ...tw, ...p }), () => undefined, urls());

  it('meldet per Geräte-Code an', async () => {
    const a = auth();
    const login = await a.startDeviceLogin();
    expect(login.userCode).toBe('ABCD-EFGH');
    expect(await a.poll()).toBe(false); // noch nicht bestätigt
    state.approved = true;
    a.cancel();
    a.pending = { ...login, deviceCode: 'DEV', interval: 1 };
    expect(await a.poll()).toBe(true);
    expect(tw).toMatchObject({ accessToken: 'ACCESS1', refreshToken: 'REFRESH1', userId: '4711', login: 'tobias', enabled: true });
  });

  it('erneuert ein abgelaufenes Token automatisch', async () => {
    tw = { ...tw, expiresAt: Date.now() - 1000 };
    const a = auth();
    const rewards = await new TwitchSource(() => tw, a, () => undefined, () => undefined, quiet).rewards();
    expect(state.refreshCalls).toBe(1);
    expect(tw.accessToken).toBe('ACCESS2');
    expect(rewards.map((r) => `${r.title}:${r.cost}`)).toEqual(['Licht an:500', 'Disco:5000']);
  });

  it('abonniert Events und meldet Kanalpunkte; Sitzungswechsel ohne neue Abos', async () => {
    const events: NormalizeResult[] = [];
    const src = new TwitchSource(() => tw, auth(), (r) => events.push(r), () => undefined, quiet);
    state.subs.length = 0;
    src.restart();
    for (let i = 0; i < 50 && src.status.state !== 'ok'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(src.status.state).toBe('ok');
    expect(state.subs.map((s) => s.type)).toContain('channel.channel_points_custom_reward_redemption.add');
    expect(state.subs.find((s) => s.type === 'channel.follow')).toMatchObject({ version: '2', condition: { broadcaster_user_id: '4711', moderator_user_id: '4711' } });
    expect(state.subs.every((s) => (s.transport as { session_id: string }).session_id === 'S1')).toBe(true);

    const note = {
      metadata: { message_id: 'n1', message_type: 'notification', message_timestamp: new Date().toISOString() },
      payload: {
        subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
        event: { user_name: 'Huebi', user_input: '', reward: { title: 'Disco', cost: 5000 } },
      },
    };
    const first = state.sockets.at(-1)!;
    first.send(JSON.stringify(note));
    first.send(JSON.stringify(note)); // doppelt zugestellt
    await new Promise((r) => setTimeout(r, 100));
    expect(events.length).toBe(1);
    expect(events[0].event).toMatchObject({ type: 'channelPoints', reward: 'Disco', amount: 5000 });

    const subsBefore = state.subs.length;
    first.send(JSON.stringify({ metadata: { message_id: 'r', message_type: 'session_reconnect' }, payload: { session: { reconnect_url: `${wsUrl}?reconnect=1` } } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(state.subs.length).toBe(subsBefore);
    expect(first.readyState).toBeGreaterThanOrEqual(2); // alte Verbindung geschlossen
    src.stop();
  });
});
