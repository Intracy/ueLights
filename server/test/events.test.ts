import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@uelights/shared';
import { encodeScene, parseSceneCatalog } from '../src/connectors/govee';
import { normalizeActivity } from '../src/events/normalize';
import { EventPipeline } from '../src/events/pipeline';
import { channelIdFromJwt } from '../src/sources/streamelements';

const settings = DEFAULT_SETTINGS.events;

const activity = (type: string, data: Record<string, unknown>, id = Math.random().toString(36)) => ({
  id,
  ts: new Date().toISOString(),
  type: 'message',
  topic: 'channel.activities',
  data: { type, provider: 'twitch', channel: 'c', data, activityId: id, createdAt: new Date().toISOString() },
});

describe('StreamElements-Normalisierung', () => {
  it('Spende mit Betrag und Währung', () => {
    const r = normalizeActivity(activity('tip', { amount: 10, currency: 'EUR', username: 'max', message: 'hi' }), settings)!;
    expect(r.event.type).toBe('tip');
    expect(r.event.amount).toBe(10);
    expect(r.event.user).toBe('max');
  });

  it('Fremdwährung wird mit festem Kurs umgerechnet', () => {
    const r = normalizeActivity(activity('tip', { amount: 10, currency: 'USD', username: 'max' }), settings)!;
    expect(r.event.amount).toBeCloseTo(9.2);
    expect(r.event.originalAmount).toBe(10);
  });

  it('Bits als cheer', () => {
    const r = normalizeActivity(activity('cheer', { amount: 500, username: 'bitsy' }), settings)!;
    expect(r.event.type).toBe('cheer');
    expect(r.event.amount).toBe(500);
  });

  it('Gift-Bombe wird gebündelt', () => {
    const p = new EventPipeline(() => 15000);
    const bundle = normalizeActivity(activity('communityGiftPurchase', { amount: 3, username: 'santa' }), settings)!;
    expect(bundle.event.type).toBe('giftSub');
    expect(p.process(bundle).drop).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const single = normalizeActivity(activity('subscriber', { gifted: true, sender: 'santa', username: `r${i}` }), settings)!;
      expect(p.process(single).drop).toMatch(/Gift-Bombe/);
    }
    // ein weiteres, einzelnes Geschenk zählt wieder
    const extra = normalizeActivity(activity('subscriber', { gifted: true, sender: 'santa', username: 'r9' }), settings)!;
    expect(p.process(extra).drop).toBeUndefined();
    expect(extra.event.type).toBe('giftSub');
  });

  it('verwirft Duplikate', () => {
    const p = new EventPipeline(() => 15000);
    const a = normalizeActivity(activity('tip', { amount: 5 }, 'same'), settings)!;
    const b = normalizeActivity(activity('tip', { amount: 5 }, 'same'), settings)!;
    expect(p.process(a).drop).toBeUndefined();
    expect(p.process(b).drop).toBe('Doppelt empfangen');
  });

  it('liest die Kanal-ID aus dem JWT', () => {
    const payload = Buffer.from(JSON.stringify({ channel: '603abc123' })).toString('base64url');
    expect(channelIdFromJwt(`x.${payload}.y`)).toBe('603abc123');
  });
});

describe('Govee-Szenen', () => {
  it('Szene ohne Parameter: ein Paket 33 05 04 + Code + Prüfsumme', () => {
    const [p] = encodeScene(0x1234);
    const b = Buffer.from(p, 'base64');
    expect(b.length).toBe(20);
    expect([...b.subarray(0, 5)]).toEqual([0x33, 0x05, 0x04, 0x34, 0x12]);
    let x = 0;
    for (const v of b.subarray(0, 19)) x ^= v;
    expect(b[19]).toBe(x);
  });

  it('Szene mit Parameter: a3-Blöcke, letzter Index ff', () => {
    const param = Buffer.alloc(40, 7).toString('base64');
    const packets = encodeScene(10, param).map((p) => Buffer.from(p, 'base64'));
    expect(packets.length).toBe(4); // 43 Byte → 3 Blöcke + Abschluss
    expect([...packets[0].subarray(0, 5)]).toEqual([0xa3, 0x00, 0x01, 3, 0x02]);
    expect(packets[2][1]).toBe(0xff);
    expect(packets[3][0]).toBe(0x33);
  });

  it('liest Katalog-Formate', () => {
    expect(parseSceneCatalog([{ name: 'Aurora', sceneCode: 1234 }])).toHaveLength(1);
    const lib = { data: { categories: [{ scenes: [{ sceneName: 'Wald', lightEffects: [{ sceneCode: 99, scenceParam: 'AQI=' }] }] }] } };
    const parsed = parseSceneCatalog(lib);
    expect(parsed[0].name).toBe('Wald');
    expect(parsed[0].data?.sceneParam).toBe('AQI=');
  });
});
