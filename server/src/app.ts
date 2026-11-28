import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  newId,
  type Alert,
  type Backup,
  type Effect,
  type EventLogEntry,
  type EventType,
  type Group,
  type Light,
  type LiveMessage,
  type LiveState,
  type NormalizedEvent,
  type Settings,
} from '@uelights/shared';
import { Auth } from './auth.js';
import { config } from './config.js';
import { parseSceneCatalog } from './connectors/govee.js';
import { DriverRegistry } from './connectors/registry.js';
import { discoverTwinkly } from './connectors/twinkly.js';
import { discoverHueBridges, pairHueBridge } from './connectors/hue.js';
import { AlertEngine } from './engine/engine.js';
import { Player } from './engine/player.js';
import { EventPipeline } from './events/pipeline.js';
import { channelIdFromJwt, StreamElementsSource } from './sources/streamelements.js';
import { Store } from './store.js';

const COOKIE = 'uelights_session';
const MASK = '••••••';

function mask(v: string): string {
  return v ? `${MASK}${v.slice(-4)}` : '';
}

export async function buildApp() {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 5 * 1024 * 1024 });
  const store = new Store(config.dataDir);
  const auth = new Auth(store, config.password, config.disableAuth);
  const S = () => store.data.settings;

  // ------------------------------ Live-Hub ---------------------------------
  const clients = new Set<WebSocket>();
  const broadcast = (msg: LiveMessage) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(data);
  };
  let stateTimer: NodeJS.Timeout | null = null;
  const pushState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      broadcast({ type: 'state', state: liveState() });
    }, 50);
  };
  const toast = (level: 'info' | 'error', text: string) => broadcast({ type: 'toast', level, text });
  const warn = (msg: string) => {
    app.log.warn(msg);
    toast('error', msg);
  };

  // ------------------------------ Kern -------------------------------------
  const registry = new DriverRegistry(S, config.haToken, config.amaranKey, pushState, (lightId, leds) =>
    broadcast({ type: 'virtualFrame', lightId, leds }),
  );
  const player = new Player({
    registry,
    getLights: () => store.data.lights,
    getGroups: () => store.data.groups,
    getEffects: () => store.data.effects,
    getSettings: S,
    warn,
  });
  const engine = new AlertEngine(player, () => store.data.alerts, S, {
    onLog: (entry: EventLogEntry) => {
      store.addLog(entry);
      broadcast({ type: 'event', entry });
    },
    onUpdate: (eventId, outcome) => {
      const e = store.log.find((x) => x.event.id === eventId);
      if (e) {
        e.outcome = outcome;
        store.scheduleLogSave();
      }
      broadcast({ type: 'eventUpdate', eventId, outcome });
    },
    onState: pushState,
    warn,
  });
  const pipeline = new EventPipeline(() => S().events.giftBundleWindowMs);
  const se = new StreamElementsSource(
    S,
    config.seJwt,
    (res) => {
      const { event, drop } = pipeline.process(res);
      engine.handle(event, drop);
    },
    pushState,
    app.log,
  );

  function liveState(): LiveState {
    const conns = [se.status, registry.ha.status, registry.amaran.status, registry.hue.status];
    if (store.data.lights.some((l) => l.connector === 'govee')) {
      conns.push({
        id: 'govee',
        label: 'Govee LAN',
        state: registry.govee.error ? 'error' : 'ok',
        detail: registry.govee.error ?? 'UDP 4001–4003',
      });
    }
    return {
      connections: conns,
      nowPlaying: engine.nowPlaying,
      queueLength: engine.queueLength,
      pendingCount: engine.pendingCount,
      triggerMode: S().triggerMode,
      paused: S().safety.paused,
    };
  }

  const restartConnections = () => {
    se.restart();
    registry.ha.restart();
    registry.amaran.restart();
    registry.hue.restart();
    if (store.data.lights.some((l) => l.connector === 'govee')) registry.govee.start();
  };

  // ------------------------------ HTTP -------------------------------------
  await app.register(fastifyCookie);

  const isAuthed = (req: FastifyRequest) => auth.check(req.cookies[COOKIE]);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url === '/api/health') return;
    if (!isAuthed(req)) return reply.code(401).send({ error: 'Nicht angemeldet' });
  });

  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

  // Auth
  app.get('/api/auth/status', async (req) => ({
    configured: auth.configured,
    authenticated: isAuthed(req),
    disabled: auth.disabled,
  }));
  app.post<{ Body: { password: string } }>('/api/auth/setup', async (req, reply) => {
    if (auth.configured) return fail(reply, 400, 'Passwort ist bereits gesetzt');
    try {
      auth.setPassword(req.body.password ?? '');
    } catch (err) {
      return fail(reply, 400, (err as Error).message);
    }
    reply.setCookie(COOKIE, auth.createSession(), { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 3600 });
    return { ok: true };
  });
  app.post<{ Body: { password: string } }>('/api/auth/login', async (req, reply) => {
    await new Promise((r) => setTimeout(r, 300));
    if (!auth.verify(req.body.password ?? '')) return fail(reply, 401, 'Falsches Passwort');
    reply.setCookie(COOKIE, auth.createSession(), { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 3600 });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    auth.destroy(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.post<{ Body: { current: string; next: string } }>('/api/auth/password', async (req, reply) => {
    if (!isAuthed(req)) return fail(reply, 401, 'Nicht angemeldet');
    if (config.password) return fail(reply, 400, 'Passwort ist per Umgebungsvariable festgelegt');
    if (!auth.verify(req.body.current ?? '')) return fail(reply, 400, 'Aktuelles Passwort stimmt nicht');
    try {
      auth.setPassword(req.body.next ?? '');
    } catch (err) {
      return fail(reply, 400, (err as Error).message);
    }
    reply.setCookie(COOKIE, auth.createSession(), { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 3600 });
    return { ok: true };
  });

  // Einstellungen (Geheimnisse maskiert)
  const publicSettings = (): Settings & { meta: Record<string, unknown> } => {
    const s = structuredClone(S());
    const jwt = config.seJwt || s.streamelements.jwt;
    s.streamelements.jwt = mask(s.streamelements.jwt);
    s.homeassistant.token = mask(s.homeassistant.token);
    s.amaran.apiKey = mask(s.amaran.apiKey);
    s.hue.appKey = mask(s.hue.appKey);
    s.hue.clientKey = mask(s.hue.clientKey);
    return {
      ...s,
      meta: {
        jwtFromEnv: !!config.seJwt,
        haTokenFromEnv: !!config.haToken,
        amaranKeyFromEnv: !!config.amaranKey,
        passwordFromEnv: !!config.password,
        detectedChannelId: jwt ? channelIdFromJwt(jwt) ?? null : null,
      },
    };
  };

  app.get('/api/bootstrap', async () => ({
    alerts: store.data.alerts,
    effects: store.data.effects,
    lights: store.data.lights,
    groups: store.data.groups,
    settings: publicSettings(),
    log: store.log.slice(0, 200),
    live: liveState(),
  }));

  app.get('/api/settings', async () => publicSettings());
  app.put<{ Body: Settings }>('/api/settings', async (req) => {
    const next = req.body;
    const cur = S();
    if (!next.streamelements.jwt || next.streamelements.jwt.startsWith(MASK)) next.streamelements.jwt = cur.streamelements.jwt;
    if (!next.homeassistant.token || next.homeassistant.token.startsWith(MASK)) next.homeassistant.token = cur.homeassistant.token;
    if (next.amaran.apiKey === undefined || next.amaran.apiKey.startsWith(MASK)) next.amaran.apiKey = cur.amaran.apiKey;
    // Hue-Schlüssel und Zertifikat setzt nur das Koppeln
    next.hue = { ...cur.hue, ...(next.hue ?? {}), appKey: cur.hue.appKey, clientKey: cur.hue.clientKey, certFingerprint: cur.hue.certFingerprint };
    if (next.hue.bridgeIp !== cur.hue.bridgeIp) next.hue = { ...next.hue, appKey: '', clientKey: '', certFingerprint: '' };
    delete (next as unknown as Record<string, unknown>).meta;
    // Pause wird nur über /api/pause geschaltet
    next.safety = { ...next.safety, paused: cur.safety.paused };
    if (next.triggerMode !== 'auto' && next.triggerMode !== 'manual') next.triggerMode = cur.triggerMode;
    const reconnect =
      JSON.stringify([cur.streamelements, cur.homeassistant, cur.amaran, cur.hue]) !==
      JSON.stringify([next.streamelements, next.homeassistant, next.amaran, next.hue]);
    store.data.settings = next;
    store.commit();
    if (reconnect) restartConnections();
    pushState();
    return publicSettings();
  });

  app.post<{ Body: { paused: boolean } }>('/api/pause', async (req) => {
    S().safety.paused = !!req.body.paused;
    store.commit();
    pushState();
    return { paused: S().safety.paused };
  });

  app.post<{ Body: { mode: 'auto' | 'manual' } }>('/api/trigger-mode', async (req, reply) => {
    if (req.body.mode !== 'auto' && req.body.mode !== 'manual') return fail(reply, 400, 'Modus muss auto oder manual sein');
    S().triggerMode = req.body.mode;
    store.commit();
    pushState();
    toast('info', req.body.mode === 'auto' ? 'Automatisch: Alerts lösen sofort aus' : 'Manuell: Alerts warten auf Freigabe');
    return { mode: S().triggerMode };
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/release', async (req, reply) => {
    if (!engine.release(req.params.id)) return fail(reply, 404, 'Event wartet nicht (mehr) auf Freigabe');
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/events/:id/dismiss', async (req, reply) => {
    if (!engine.dismiss(req.params.id)) return fail(reply, 404, 'Event wartet nicht (mehr) auf Freigabe');
    return { ok: true };
  });
  app.post('/api/pending/release-all', async () => ({ released: engine.releaseAll() }));
  app.post('/api/pending/dismiss-all', async () => ({ dismissed: engine.dismissAll() }));

  app.post('/api/stop', async () => {
    engine.stopAll();
    await Promise.all(
      store.data.lights
        .filter((l) => l.enabled && l.restState.mode !== 'snapshot' && !(S().safety.lockSceneLights && l.role === 'scene'))
        .map((l) => player.applyRest(l, registry.get(l))),
    );
    toast('info', 'Alles gestoppt');
    return { ok: true };
  });

  // Generische Listen-Endpunkte
  function crud<T extends { id: string }>(name: string, list: () => T[], set: (v: T[]) => void, prefix: string, onChange?: (item?: T, removedId?: string) => void) {
    app.post<{ Body: T }>(`/api/${name}`, async (req) => {
      const body = req.body as T;
      const item = { ...body, id: body.id || newId(prefix) } as T;
      set([...list(), item]);
      store.commit();
      onChange?.(item);
      return item;
    });
    app.put<{ Params: { id: string }; Body: T }>(`/api/${name}/:id`, async (req, reply) => {
      const idx = list().findIndex((x) => x.id === req.params.id);
      if (idx < 0) return fail(reply, 404, 'Nicht gefunden');
      const item = { ...(req.body as T), id: req.params.id } as T;
      const next = list().slice();
      next[idx] = item;
      set(next);
      store.commit();
      onChange?.(item);
      return item;
    });
    app.delete<{ Params: { id: string } }>(`/api/${name}/:id`, async (req) => {
      set(list().filter((x) => x.id !== req.params.id));
      store.commit();
      onChange?.(undefined, req.params.id);
      return { ok: true };
    });
    /** Gesamte Liste ersetzen (Reihenfolge = Priorität) */
    app.put<{ Body: T[] }>(`/api/${name}`, async (req) => {
      set(req.body as T[]);
      store.commit();
      onChange?.();
      return list();
    });
  }

  crud<Alert>('alerts', () => store.data.alerts, (v) => (store.data.alerts = v), 'al');
  crud<Effect>('effects', () => store.data.effects, (v) => (store.data.effects = v), 'fx');
  crud<Group>('groups', () => store.data.groups, (v) => (store.data.groups = v), 'grp');
  crud<Light>('lights', () => store.data.lights, (v) => (store.data.lights = v), 'li', (item, removedId) => {
    if (removedId) {
      registry.remove(removedId);
      store.data.groups = store.data.groups.map((g) => ({ ...g, lightIds: g.lightIds.filter((id) => id !== removedId) }));
      store.commit();
      return;
    }
    if (!item) return;
    if (item.connector === 'govee') registry.govee.start();
    const driver = registry.get(item);
    // Twinkly: LED-Anzahl und Stränge gleich beim Speichern vom Gerät lesen
    if (item.connector === 'twinkly' && item.config.host) {
      driver
        .probe()
        .then((res) => {
          const cur = store.data.lights.find((l) => l.id === item.id);
          if (cur && res.ok && res.ledCount && res.ledCount !== cur.ledCount) saveLight({ ...cur, ledCount: res.ledCount });
        })
        .catch(() => undefined);
    }
  });

  const findLight = (id: string) => store.data.lights.find((l) => l.id === id);
  const saveLight = (light: Light) => {
    store.data.lights = store.data.lights.map((l) => (l.id === light.id ? light : l));
    store.commit();
  };

  app.post<{ Params: { id: string } }>('/api/lights/:id/probe', async (req, reply) => {
    const light = findLight(req.params.id);
    if (!light) return fail(reply, 404, 'Licht nicht gefunden');
    const res = await registry.get(light).probe();
    if (res.ok && res.ledCount && res.ledCount !== light.ledCount) saveLight({ ...light, ledCount: res.ledCount });
    return res;
  });

  app.post<{ Params: { id: string } }>('/api/lights/:id/identify', async (req, reply) => {
    const light = findLight(req.params.id);
    if (!light) return fail(reply, 404, 'Licht nicht gefunden');
    player.identify(light).catch((err) => warn(`${light.name}: ${err.message}`));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/lights/:id/natives/refresh', async (req, reply) => {
    const light = findLight(req.params.id);
    if (!light) return fail(reply, 404, 'Licht nicht gefunden');
    try {
      const natives = await registry.get(light).listNative();
      const next = { ...light, nativeEffects: natives };
      saveLight(next);
      return next;
    } catch (err) {
      return fail(reply, 502, (err as Error).message);
    }
  });

  app.post<{ Params: { id: string }; Body: { catalog: unknown; replace?: boolean } }>(
    '/api/lights/:id/natives/import',
    async (req, reply) => {
      const light = findLight(req.params.id);
      if (!light) return fail(reply, 404, 'Licht nicht gefunden');
      const parsed = parseSceneCatalog(req.body.catalog);
      if (!parsed.length) return fail(reply, 400, 'Keine Szenen im Katalog gefunden');
      const next = { ...light, nativeEffects: req.body.replace ? parsed : [...light.nativeEffects, ...parsed] };
      saveLight(next);
      return next;
    },
  );

  app.post<{ Params: { id: string; nativeId: string } }>('/api/lights/:id/natives/:nativeId/play', async (req, reply) => {
    const light = findLight(req.params.id);
    if (!light) return fail(reply, 404, 'Licht nicht gefunden');
    player.previewNative(light, decodeURIComponent(req.params.nativeId)).catch((err) => warn(`${light.name}: ${err.message}`));
    return { ok: true };
  });

  app.post<{ Body: { effect: Effect; lightId: string; amount?: number } }>('/api/effects/preview', async (req, reply) => {
    const light = findLight(req.body.lightId);
    if (!light) return fail(reply, 404, 'Licht nicht gefunden');
    player.preview(light, req.body.effect, req.body.amount).catch((err) => warn(`${light.name}: ${err.message}`));
    return { ok: true };
  });

  // Tests
  const testEvent = (b: Partial<NormalizedEvent> & { type: EventType }): NormalizedEvent => ({
    id: newId('test'),
    source: 'test',
    rawType: b.type,
    isTest: true,
    ts: new Date().toISOString(),
    user: b.user ?? 'testzuschauer',
    currency: b.type === 'tip' ? S().events.channelCurrency : undefined,
    ...b,
  });

  app.post<{ Body: Partial<NormalizedEvent> & { type: EventType } }>('/api/test-event', async (req) => {
    const ev = testEvent(req.body);
    engine.handle(ev);
    return { ok: true, event: ev };
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/replay', async (req, reply) => {
    const entry = store.log.find((e) => e.event.id === req.params.id);
    if (!entry) return fail(reply, 404, 'Event nicht mehr im Protokoll');
    const ev: NormalizedEvent = {
      ...entry.event,
      id: newId('replay'),
      source: entry.event.source === 'streamelements' ? 'manual' : entry.event.source,
      ts: new Date().toISOString(),
      raw: undefined,
    };
    engine.handle(ev, undefined, { forcePlay: true });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { tierId?: string; amount?: number; message?: string } }>(
    '/api/alerts/:id/fire',
    async (req, reply) => {
      const alert = store.data.alerts.find((a) => a.id === req.params.id);
      if (!alert) return fail(reply, 404, 'Alert nicht gefunden');
      const tier = alert.mode === 'tiers' ? alert.tiers.find((t) => t.id === req.body.tierId) ?? alert.tiers[0] : undefined;
      let amount = req.body.amount;
      if (amount === undefined && tier) {
        const a = tier.amount;
        amount = a.mode === 'exact' ? a.value : a.mode === 'range' || a.mode === 'min' ? a.min : undefined;
      }
      engine.fire(alert, tier, testEvent({ type: alert.trigger, amount, message: req.body.message }));
      return { ok: true };
    },
  );

  // Geräte finden
  app.get('/api/discover/twinkly', async () => discoverTwinkly());
  app.get('/api/discover/govee', async () => registry.govee.scan());
  app.get('/api/discover/homeassistant', async (_req, reply) => {
    if (registry.ha.status.state !== 'ok') return fail(reply, 503, 'Home Assistant ist nicht verbunden');
    return registry.ha.entities();
  });
  // Philips Hue
  app.get('/api/hue/bridges', async () => discoverHueBridges());
  app.post<{ Body: { ip: string } }>('/api/hue/pair', async (req, reply) => {
    const ip = String(req.body?.ip ?? '').trim();
    if (!/^[\w.:-]+$/.test(ip)) return fail(reply, 400, 'Ungültige Adresse');
    try {
      const r = await pairHueBridge(ip);
      S().hue = { enabled: true, bridgeIp: ip, appKey: r.appKey, clientKey: r.clientKey ?? '', certFingerprint: r.fingerprint ?? '' };
      store.commit();
      await registry.hue.restart();
      pushState();
      return { ok: true, status: registry.hue.status };
    } catch (err) {
      return fail(reply, 409, (err as Error).message);
    }
  });
  app.get('/api/discover/hue', async (_req, reply) => {
    if (!registry.hue.configured) return fail(reply, 503, 'Hue Bridge ist nicht gekoppelt');
    try {
      return await registry.hue.targets();
    } catch (err) {
      return fail(reply, 503, (err as Error).message);
    }
  });
  /** Alle Hue-Lampen als Lichter anlegen, je Raum eine Gruppe */
  app.post('/api/hue/import', async (_req, reply) => {
    if (!registry.hue.configured) return fail(reply, 503, 'Hue Bridge ist nicht gekoppelt');
    let targets;
    try {
      targets = await registry.hue.targets();
    } catch (err) {
      return fail(reply, 503, (err as Error).message);
    }
    const known = new Set(store.data.lights.filter((l) => l.connector === 'hue').map((l) => l.config.hueId));
    let added = 0;
    const byRoom = new Map<string, string[]>();
    for (const t of targets.filter((x) => x.type === 'light')) {
      let light = store.data.lights.find((l) => l.connector === 'hue' && l.config.hueId === t.id);
      if (!known.has(t.id)) {
        light = {
          id: newId('li'),
          name: t.name,
          connector: 'hue',
          config: { hueId: t.id, hueType: 'light' },
          role: 'deco',
          restState: { mode: 'snapshot' },
          nativeEffects: [],
          enabled: true,
        };
        store.data.lights.push(light);
        added++;
      }
      if (t.groupId && light) byRoom.set(t.groupId, [...(byRoom.get(t.groupId) ?? []), light.id]);
    }
    const rooms = new Map(targets.filter((t) => t.kind === 'Raum').map((t) => [t.groupId!, t.name]));
    let groups = 0;
    for (const [roomId, ids] of byRoom) {
      const name = `Hue: ${rooms.get(roomId) ?? 'Raum'}`;
      const g = store.data.groups.find((x) => x.name === name);
      if (g) g.lightIds = [...new Set([...g.lightIds, ...ids])];
      else {
        store.data.groups.push({ id: newId('grp'), name, lightIds: ids });
        groups++;
      }
    }
    store.commit();
    pushState();
    return { ok: true, added, groups, total: targets.filter((x) => x.type === 'light').length };
  });

  app.get('/api/discover/amaran', async (_req, reply) => {
    try {
      return await registry.amaran.devices();
    } catch (err) {
      return fail(reply, 503, (err as Error).message);
    }
  });

  // Backup
  app.get('/api/export', async (_req, reply) => {
    const s = structuredClone(S()) as Settings;
    const { jwt: _jwt, ...seRest } = s.streamelements;
    const { token: _tok, ...haRest } = s.homeassistant;
    const { apiKey: _ak, ...amRest } = s.amaran;
    const { appKey: _hk, clientKey: _hc, certFingerprint: _hf, ...hueRest } = s.hue;
    const backup: Backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      alerts: store.data.alerts,
      effects: store.data.effects,
      lights: store.data.lights,
      groups: store.data.groups,
      settings: { ...s, streamelements: seRest, homeassistant: haRest, amaran: amRest as Settings['amaran'], hue: hueRest as Settings['hue'] },
    };
    reply.header('Content-Disposition', `attachment; filename="uelights-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return backup;
  });
  app.post<{ Body: Backup }>('/api/import', async (req, reply) => {
    const b = req.body;
    if (b?.version !== 1 || !Array.isArray(b.alerts)) return fail(reply, 400, 'Keine gültige ueLights-Sicherung');
    const cur = S();
    store.data.alerts = b.alerts;
    store.data.effects = b.effects ?? [];
    store.data.lights = b.lights ?? [];
    store.data.groups = b.groups ?? [];
    if (b.settings) {
      store.data.settings = {
        ...(b.settings as unknown as Settings),
        streamelements: { ...b.settings.streamelements, jwt: cur.streamelements.jwt },
        homeassistant: { ...b.settings.homeassistant, token: cur.homeassistant.token },
        amaran: { ...cur.amaran, ...b.settings.amaran, apiKey: cur.amaran.apiKey },
        hue: { ...cur.hue, ...(b.settings.hue ?? {}), appKey: cur.hue.appKey, clientKey: cur.hue.clientKey, certFingerprint: cur.hue.certFingerprint },
      };
    }
    store.commit();
    restartConnections();
    return { ok: true };
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ------------------------------ Web-App ----------------------------------
  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Nicht gefunden' });
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`Web-App nicht gefunden unter ${config.webDir} – nur API aktiv`);
  }

  // ------------------------------ WebSocket --------------------------------
  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith('/api/live')) return socket.destroy();
    const cookies = app.parseCookie(req.headers.cookie ?? '');
    if (!auth.check(cookies[COOKIE])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', state: liveState() } satisfies LiveMessage));
      ws.on('close', () => clients.delete(ws));
    });
  });

  app.addHook('onReady', async () => {
    restartConnections();
  });
  app.addHook('onClose', async () => {
    se.stop();
    registry.stopAll();
    store.flush();
    for (const c of clients) c.close();
  });

  return app;
}
