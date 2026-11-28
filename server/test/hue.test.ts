import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Light, type Settings } from '@uelights/shared';
import { HueClient, HueDriver, pairHueBridge, rgbToXy } from '../src/connectors/hue.js';

/** Selbstsigniertes Zertifikat wie bei der echten Bridge */
function cert(cn: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hue-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) };
}

const GAMUT_C = { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } };
const state = {
  linkPressed: false,
  puts: [] as Array<{ path: string; body: Record<string, unknown>; at: number }>,
};
const data: Record<string, unknown[]> = {
  light: [
    { id: 'L1', type: 'light', metadata: { name: 'Regal' }, on: { on: true }, dimming: { brightness: 40 }, color: { xy: { x: 0.3, y: 0.3 }, gamut: GAMUT_C }, color_temperature: { mirek: null, mirek_valid: false }, effects: { effect_values: ['no_effect', 'candle', 'fire'] } },
    { id: 'L2', type: 'light', metadata: { name: 'Decke' }, on: { on: false }, dimming: { brightness: 80 }, color_temperature: { mirek: 300, mirek_valid: true } },
  ],
  device: [
    { id: 'D1', type: 'device', services: [{ rid: 'L1', rtype: 'light' }] },
    { id: 'D2', type: 'device', services: [{ rid: 'L2', rtype: 'light' }] },
  ],
  room: [{ id: 'R1', type: 'room', metadata: { name: 'Studio' }, children: [{ rid: 'D1', rtype: 'device' }, { rid: 'D2', rtype: 'device' }], services: [{ rid: 'G1', rtype: 'grouped_light' }] }],
  zone: [],
  grouped_light: [{ id: 'G1', type: 'grouped_light', owner: { rid: 'R1', rtype: 'room' }, on: { on: true } }],
  scene: [{ id: 'S1', type: 'scene', metadata: { name: 'Stream' }, group: { rid: 'R1', rtype: 'room' }, palette: { color: [{}, {}] } }],
  bridge_home: [],
};

let server: https.Server;
let host = '';
const creds = cert('ecb5fafffe000000');

beforeAll(async () => {
  server = https.createServer(creds, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, o: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? '';
      if (url === '/api' && req.method === 'POST') {
        return send(200, state.linkPressed ? [{ success: { username: 'APPKEY123', clientkey: 'CK' } }] : [{ error: { type: 101, description: 'link button not pressed' } }]);
      }
      if (req.headers['hue-application-key'] !== 'APPKEY123') return send(403, { errors: [{ description: 'unauthorized user' }] });
      const m = url.match(/^\/clip\/v2\/resource\/(\w+)(?:\/(\w+))?$/);
      if (!m) return send(404, { errors: [{ description: 'not found' }] });
      if (req.method === 'GET') return send(200, { data: data[m[1]] ?? [], errors: [] });
      state.puts.push({ path: `${m[1]}/${m[2]}`, body: JSON.parse(body || '{}'), at: Date.now() });
      return send(200, { data: [{ rid: m[2] }], errors: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('Hue', () => {
  it('rechnet RGB in xy um und hält den Farbraum der Lampe ein', () => {
    const red = rgbToXy({ r: 255, g: 0, b: 0 }, GAMUT_C);
    expect(red.x).toBeCloseTo(0.6915, 2);
    expect(red.y).toBeCloseTo(0.3083, 2);
    const white = rgbToXy({ r: 255, g: 255, b: 255 });
    expect(white.x).toBeCloseTo(0.3227, 2);
  });

  let settings: Settings['hue'];
  it('koppelt erst nach Druck auf die Link-Taste und merkt sich das Zertifikat', async () => {
    await expect(pairHueBridge(host)).rejects.toThrow(/Link-Taste/);
    state.linkPressed = true;
    const r = await pairHueBridge(host);
    expect(r.appKey).toBe('APPKEY123');
    expect(r.fingerprint).toMatch(/^[0-9A-F:]+$/);
    settings = { ...DEFAULT_SETTINGS.hue, enabled: true, bridgeIp: host, appKey: r.appKey, certFingerprint: r.fingerprint! };
  });

  it('listet Lampen, Räume und ordnet Lampen ihrem Raum zu', async () => {
    const c = new HueClient(() => settings, () => undefined);
    await c.restart();
    expect(c.status.state).toBe('ok');
    const t = await c.targets();
    expect(t.map((x) => `${x.kind}:${x.name}`)).toEqual(['Lampe:Regal', 'Lampe:Decke', 'Raum:Studio']);
    expect(t[0].groupId).toBe('R1');
    expect(c.lightsInGroup('R1')).toEqual(['L1', 'L2']);
    c.stop();
  });

  it('schaltet Farbe, liest Szenen und Effekte und stellt den Zustand wieder her', async () => {
    const c = new HueClient(() => settings, () => undefined);
    await c.restart();
    const light = { id: 'x', name: 'Regal', connector: 'hue', config: { hueId: 'L1', hueType: 'light' }, role: 'deco', enabled: true, restState: { mode: 'snapshot' }, nativeEffects: [] } as unknown as Light;
    const d = new HueDriver(light, c, () => 5);
    state.puts.length = 0;
    const snap = await d.snapshot();
    await d.setColor({ r: 255, g: 0, b: 0 }, 70);
    const put = state.puts.at(-1)!;
    expect(put.path).toBe('light/L1');
    expect(put.body).toMatchObject({ on: { on: true }, dimming: { brightness: 70 } });
    expect((put.body.color as { xy: { x: number } }).xy.x).toBeCloseTo(0.6915, 2);

    const natives = await d.listNative();
    expect(natives.map((n) => n.name)).toEqual(['Szene: Stream', 'Szene: Stream (dynamisch)', 'Effekt: Kerze', 'Effekt: Kaminfeuer']);
    await d.playNative(natives[1]);
    expect(state.puts.at(-1)).toMatchObject({ path: 'scene/S1', body: { recall: { action: 'dynamic_palette' } } });

    await d.restore(snap);
    expect(state.puts.at(-1)!.body).toMatchObject({ on: { on: true }, dimming: { brightness: 40 }, color: { xy: { x: 0.3, y: 0.3 } } });
    c.stop();
  });

  it('fasst schnelle Raum-Befehle zusammen (höchstens 1 pro Sekunde)', async () => {
    const c = new HueClient(() => settings, () => undefined);
    await c.restart();
    const room = { id: 'r', name: 'Studio', connector: 'hue', config: { hueId: 'G1', hueType: 'grouped_light' }, role: 'deco', enabled: true, restState: { mode: 'snapshot' }, nativeEffects: [] } as unknown as Light;
    const d = new HueDriver(room, c, () => 10);
    state.puts.length = 0;
    await d.setColor({ r: 255, g: 0, b: 255 }, 80);
    const more = [200, 150, 100, 50].map((r) => d.setColor({ r, g: 0, b: 255 }, 80));
    await new Promise((r) => setTimeout(r, 300));
    expect(state.puts.filter((p) => p.path === 'grouped_light/G1').length).toBe(1);
    await Promise.all(more);
    const after = state.puts.filter((p) => p.path === 'grouped_light/G1');
    expect(after.length).toBe(2);
    expect(after[1].at - after[0].at).toBeGreaterThanOrEqual(950);
    // der neueste Stand gewinnt
    expect((after[1].body.color as { xy: { x: number } }).xy).toEqual(rgbToXy({ r: 50, g: 0, b: 255 }));
    c.stop();
  });

  it('lehnt eine Bridge mit fremdem Zertifikat ab', async () => {
    const c = new HueClient(() => ({ ...settings, certFingerprint: 'AA:BB' }), () => undefined);
    await c.restart();
    expect(c.status.state).toBe('error');
    expect(c.status.detail).toMatch(/Zertifikat/);
    c.stop();
  });
});
