import http from 'node:http';
import dgram from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Light } from '@uelights/shared';
import { TwinklyDriver } from '../src/connectors/twinkly.js';

/** Nachgebauter Twinkly-Controller mit zwei Strängen à 250 LEDs */
let server: http.Server;
let port = 0;
let gestaltLeds = 250;
const udp = dgram.createSocket('udp4');
const packets: Buffer[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (o: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(o));
      };
      const p = req.url ?? '';
      if (p.endsWith('/gestalt')) return send({ product_name: 'Twinkly', number_of_led: gestaltLeds, led_profile: 'RGB', fw_family: 'G', code: 1000 });
      if (p.endsWith('/login')) return send({ authentication_token: Buffer.alloc(8, 7).toString('base64'), 'challenge-response': 'x', authentication_token_expires_in: 14400, code: 1000 });
      if (p.endsWith('/verify')) return send({ code: 1000 });
      if (p.endsWith('/led/config')) return send({ strings: [{ first_led_id: 0, length: 250 }, { first_led_id: 250, length: 250 }], code: 1000 });
      return send({ code: 1000 });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  udp.on('message', (m) => packets.push(m));
  await new Promise<void>((r) => udp.bind(7777, '127.0.0.1', () => r()));
});

afterAll(() => {
  server.close();
  udp.close();
});

const light = (): Light =>
  ({ id: 't', name: 'Twinkly', connector: 'twinkly', config: { host: `127.0.0.1:${port}` }, role: 'deco', enabled: true, restState: { mode: 'snapshot' }, nativeEffects: [] }) as unknown as Light;

describe('Twinkly mit zwei Strängen', () => {
  it('erkennt 500 LEDs, auch wenn gestalt nur einen Strang meldet', async () => {
    gestaltLeds = 250;
    const d = new TwinklyDriver(light());
    const res = await d.probe();
    expect(res.ok).toBe(true);
    expect(res.ledCount).toBe(500);
    expect(res.detail).toContain('2 Stränge (250 + 250)');
  });

  it('übernimmt die Summe aus gestalt', async () => {
    gestaltLeds = 500;
    const d = new TwinklyDriver(light());
    expect((await d.probe()).ledCount).toBe(500);
  });

  it('lernt die LED-Anzahl vor dem ersten Echtzeitbild und füllt beide Stränge', async () => {
    gestaltLeds = 250;
    const d = new TwinklyDriver(light()); // ohne Prüfen, Standard wäre 250
    await d.beginRealtime();
    expect(d.ledCount()).toBe(500);
    packets.length = 0;
    await d.sendFrame(new Array(d.ledCount()).fill({ r: 255, g: 0, b: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    const payload = packets.reduce((n, p) => n + p.length - 12, 0);
    expect(payload).toBe(500 * 3);
    d.dispose();
  });
});
