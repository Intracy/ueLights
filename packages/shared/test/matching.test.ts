import { describe, expect, it } from 'vitest';
import { matchAmount, pickAlerts, selectTier, validateTiers, type Alert, type NormalizedEvent, type Tier } from '../src';

const tier = (id: string, amount: Tier['amount']): Tier => ({ id, label: id, amount, tracks: [] });

const tiers: Tier[] = [
  tier('t1', { mode: 'range', min: 1, max: 4.99 }),
  tier('t2', { mode: 'range', min: 5, max: 9.99 }),
  tier('t3', { mode: 'range', min: 10, max: 49.99 }),
  tier('t4', { mode: 'min', min: 50 }),
  tier('leet', { mode: 'exact', value: 13.37 }),
];

const ev = (over: Partial<NormalizedEvent>): NormalizedEvent => ({
  id: 'e',
  source: 'test',
  type: 'tip',
  rawType: 'tip',
  isTest: false,
  ts: new Date().toISOString(),
  ...over,
});

const alert = (over: Partial<Alert>): Alert => ({
  id: 'a',
  name: 'A',
  enabled: true,
  trigger: 'tip',
  conditions: { amount: { mode: 'any' }, allowTest: true },
  mode: 'single',
  tracks: [],
  tiers: [],
  after: 'restore',
  cooldownMs: 0,
  overlap: 'exclusive',
  ...over,
});

describe('Betragsstufen', () => {
  it('ordnet Beträge der richtigen Stufe zu', () => {
    expect(selectTier(tiers, 1)?.id).toBe('t1');
    expect(selectTier(tiers, 4.99)?.id).toBe('t1');
    expect(selectTier(tiers, 5)?.id).toBe('t2');
    expect(selectTier(tiers, 10)?.id).toBe('t3');
    expect(selectTier(tiers, 50)?.id).toBe('t4');
    expect(selectTier(tiers, 500)?.id).toBe('t4');
    expect(selectTier(tiers, 0.5)).toBeUndefined();
  });

  it('exakter Betrag schlägt Bereich', () => {
    expect(selectTier(tiers, 13.37)?.id).toBe('leet');
  });

  it('rechnet in Cent (kein Gleitkomma-Fehler)', () => {
    expect(matchAmount({ mode: 'exact', value: 4.2 }, 4.199999999)).toBe(true);
    expect(matchAmount({ mode: 'range', min: 5, max: 9.99 }, 9.99)).toBe(true);
  });

  it('erkennt Lücken und Überschneidungen', () => {
    expect(validateTiers(tiers)).toEqual([]);
    const bad = [tier('a', { mode: 'range', min: 1, max: 5 }), tier('b', { mode: 'range', min: 5, max: 9 }), tier('c', { mode: 'min', min: 20 })];
    const problems = validateTiers(bad);
    expect(problems.some((p) => p.includes('überschneidet'))).toBe(true);
    expect(problems.some((p) => p.includes('Lücke'))).toBe(true);
  });
});

describe('Alert-Auswahl', () => {
  it('spezifischster exklusiver Alert gewinnt, zusätzliche laufen mit', () => {
    const all = [
      alert({ id: 'allgemein', conditions: { amount: { mode: 'any' }, allowTest: true } }),
      alert({ id: 'ab10', conditions: { amount: { mode: 'min', min: 10 }, allowTest: true } }),
      alert({ id: 'extra', overlap: 'additive' }),
    ];
    const picked = pickAlerts(all, ev({ amount: 12 })).map((m) => m.alert.id);
    expect(picked).toEqual(['ab10', 'extra']);
    expect(pickAlerts(all, ev({ amount: 3 })).map((m) => m.alert.id)).toEqual(['allgemein', 'extra']);
  });

  it('Testevents nur wenn erlaubt', () => {
    const a = alert({ conditions: { amount: { mode: 'any' }, allowTest: false } });
    expect(pickAlerts([a], ev({ isTest: true }))).toHaveLength(0);
    expect(pickAlerts([a], ev({ isTest: false }))).toHaveLength(1);
  });

  it('Stufen-Alert liefert die Stufe', () => {
    const a = alert({ mode: 'tiers', tiers });
    expect(pickAlerts([a], ev({ amount: 7 }))[0].tier?.id).toBe('t2');
    expect(pickAlerts([a], ev({ amount: 0.1 }))).toHaveLength(0);
  });

  it('Kanalpunkte nach Belohnungsname', () => {
    const a = alert({ trigger: 'channelPoints', conditions: { amount: { mode: 'any' }, reward: 'Farbe wählen', allowTest: true } });
    expect(pickAlerts([a], ev({ type: 'channelPoints', reward: 'farbe wählen' }))).toHaveLength(1);
    expect(pickAlerts([a], ev({ type: 'channelPoints', reward: 'Hydrate' }))).toHaveLength(0);
  });
});
