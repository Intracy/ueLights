import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@uelights/shared';
import { AmaranClient, amaranKeyBytes, amaranToken } from '../src/connectors/amaran.js';

const KEY_HEX = crypto.randomBytes(32).toString('hex');

function decrypt(token: string, key: Buffer): string {
  const b = Buffer.from(token, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

describe('amaran-Token', () => {
  it('verschlüsselt den Unix-Zeitstempel mit dem Key (AES-256-GCM, IV|Tag|Chiffrat)', () => {
    const now = 1_790_000_000_000;
    const t = amaranToken(KEY_HEX, now);
    expect(decrypt(t, Buffer.from(KEY_HEX, 'hex'))).toBe('1790000000');
  });

  it('akzeptiert Hex, Base64 und sonstigen Text als Key', () => {
    const raw = crypto.randomBytes(32);
    expect(amaranKeyBytes(raw.toString('hex')).equals(raw)).toBe(true);
    expect(amaranKeyBytes(raw.toString('base64')).equals(raw)).toBe(true);
    expect(amaranKeyBytes('mein-key').length).toBe(32);
  });
});

/** Nachgebaute amaran-Desktop-App */
let wss: WebSocketServer | null = null;
afterEach(() => {
  wss?.close();
  wss = null;
});

function fakeDesktop(protocol: 1 | 2, seen: Array<Record<string, unknown>>): Promise<number> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve((wss!.address() as { port: number }).port));
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        seen.push(m);
        if (protocol === 1) {
          ws.send(JSON.stringify({ version: 1, code: 0, request: { type: m.type }, data: m.type === 'get_device_list' ? [{ node_id: 'N1', name: 'Pano' }] : {} }));
          return;
        }
        // v2 prüft das Token
        let valid = false;
        try {
          valid = /^\d+$/.test(decrypt(m.token, Buffer.from(KEY_HEX, 'hex')));
        } catch {
          valid = false;
        }
        const base = { version: 2, type: 'response', client_id: m.client_id, request_id: m.request_id, action: m.action };
        if (!valid) return ws.send(JSON.stringify({ ...base, code: 401, message: 'invalid token' }));
        const data = m.action === 'get_protocol_versions' ? { versions: [2] } : m.action === 'get_device_list' ? [{ node_id: 'N1', name: 'Pano' }] : {};
        ws.send(JSON.stringify({ ...base, code: 0, data }));
      });
    });
  });
}

const settings = (port: number, apiKey: string): Settings['amaran'] => ({ ...DEFAULT_SETTINGS.amaran, enabled: true, url: `ws://127.0.0.1:${port}/ws`, apiKey });
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('amaran Desktop', () => {
  it('spricht Protokoll v2 mit gültigem Token', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = await fakeDesktop(2, seen);
    const c = new AmaranClient(() => settings(port, KEY_HEX), () => undefined);
    c.restart();
    await until(() => c.status.state === 'ok' && seen.length > 0);
    expect(await c.devices()).toEqual([{ nodeId: 'N1', name: 'Pano' }]);
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ version: 2, type: 'request', action: 'get_device_list' });
    expect(typeof last.request_id).toBe('string');
    expect(c.status.detail).toContain('mit API-Key');
    c.stop();
  });

  it('meldet einen abgelehnten Key', async () => {
    const port = await fakeDesktop(2, []);
    const c = new AmaranClient(() => settings(port, 'falscher-key'), () => undefined);
    c.restart();
    await until(() => c.status.state === 'error');
    expect(c.status.detail).toMatch(/API-Key abgelehnt/);
    c.stop();
  });

  it('fällt bei alter Desktop-App auf das alte Format zurück', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = await fakeDesktop(1, seen);
    const c = new AmaranClient(() => settings(port, ''), () => undefined);
    c.restart();
    await until(() => c.protocol === 1);
    expect(await c.devices()).toEqual([{ nodeId: 'N1', name: 'Pano' }]);
    expect(seen.at(-1)).toMatchObject({ version: 1, type: 'get_device_list' });
    c.stop();
  });
});

import { normalizeWsUrl } from '../src/connectors/types.js';

describe('robust gegen Fehleingaben', () => {
  it('vervollständigt die amaran-Adresse', () => {
    expect(normalizeWsUrl('192.168.0.25:33783')).toBe('ws://192.168.0.25:33783/ws');
    expect(normalizeWsUrl('192.168.0.25')).toBe('ws://192.168.0.25:33782/ws');
    expect(normalizeWsUrl(' ws://192.168.0.25:33783/ws ')).toBe('ws://192.168.0.25:33783/ws');
    expect(normalizeWsUrl('http://pc:33783')).toBe('ws://pc:33783/ws');
  });

  it('übersteht unerwartete Nachrichten der Desktop-App', async () => {
    const wsMod = await import('ws');
    const srv = new wsMod.WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => srv.once('listening', r));
    srv.on('connection', (ws) => {
      for (const m of ['null', '42', '"x"', '[1]', '{"type":"event","data":null}']) ws.send(m);
    });
    const port = (srv.address() as { port: number }).port;
    const c = new AmaranClient(() => ({ ...DEFAULT_SETTINGS.amaran, enabled: true, url: `127.0.0.1:${port}` }), () => undefined);
    c.restart();
    await new Promise((r) => setTimeout(r, 300));
    expect(['ok', 'connecting']).toContain(c.status.state);
    c.stop();
    srv.close();
  });
});

import { AmaranDriver, guessAmaranColor, rgbToCct } from '../src/connectors/amaran.js';
import type { Light } from '@uelights/shared';

describe('Bi-Color-Leuchten', () => {
  it('erkennt Vollfarbe und Bi-Color am Modellnamen', () => {
    expect(guessAmaranColor('Pano 60C')).toBe('rgb');
    expect(guessAmaranColor('amaran 150c')).toBe('rgb');
    expect(guessAmaranColor('Halo 60x')).toBe('cct');
    expect(guessAmaranColor('COB 60x S')).toBe('cct');
    expect(guessAmaranColor('Verge Max')).toBe('cct');
    expect(guessAmaranColor('Studio links')).toBe('unknown');
  });

  it('übersetzt Farben in Weißtöne', () => {
    expect(rgbToCct({ r: 255, g: 255, b: 255 })).toBe(5600);
    expect(rgbToCct({ r: 255, g: 80, b: 0 })).toBe(2700);
    expect(rgbToCct({ r: 0, g: 0, b: 255 })).toBe(6500);
    expect(rgbToCct({ r: 0, g: 255, b: 0 })).toBe(5600);
  });

  const fakeClient = (rejectHsi: boolean) => {
    const calls: Array<{ action: string; args?: Record<string, unknown> }> = [];
    const client = {
      protocol: 2,
      request: async (action: string, _node?: string, args?: Record<string, unknown>) => {
        calls.push({ action, args });
        if (action === 'set_hsi' && rejectHsi) throw new Error('amaran set_hsi: not supported');
        return {};
      },
    };
    return { client, calls };
  };
  const light = (name: string, amaranColor?: 'auto' | 'rgb' | 'cct') =>
    ({ id: 'a', name, connector: 'amaran', config: { nodeId: 'N1', amaranColor }, role: 'deco', enabled: true, restState: { mode: 'snapshot' }, nativeEffects: [] }) as unknown as Light;
  const settings = () => DEFAULT_SETTINGS.amaran;

  it('schickt an Bi-Color-Leuchten Weißtöne statt Farbe', async () => {
    const { client, calls } = fakeClient(false);
    const d = new AmaranDriver(light('Halo 60x'), client as never, settings);
    await d.setColor({ r: 255, g: 0, b: 0 }, 50);
    expect(calls.at(-1)).toEqual({ action: 'set_cct', args: { cct: 2700, intensity: 500 } });
  });

  it('schickt an Vollfarb-Leuchten Farbe', async () => {
    const { client, calls } = fakeClient(false);
    const d = new AmaranDriver(light('Pano 60C'), client as never, settings);
    await d.setColor({ r: 0, g: 0, b: 255 }, 100);
    expect(calls.at(-1)).toMatchObject({ action: 'set_hsi', args: { hue: 240, sat: 100, intensity: 1000 } });
  });

  it('lernt bei unbekanntem Modell aus der Ablehnung', async () => {
    const { client, calls } = fakeClient(true);
    const d = new AmaranDriver(light('Studio links'), client as never, settings);
    await d.setColor({ r: 0, g: 0, b: 255 }, 100);
    expect(calls.slice(-2).map((c) => c.action)).toEqual(['set_hsi', 'set_cct']);
    await d.setColor({ r: 0, g: 0, b: 255 }, 100);
    expect(calls.at(-1)!.action).toBe('set_cct');
    expect(d.colorMode()).toBe('cct');
  });
});
