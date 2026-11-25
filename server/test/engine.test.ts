import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Alert, type EventLogEntry, type EventOutcome, type NormalizedEvent, type Settings } from '@uelights/shared';
import { AlertEngine } from '../src/engine/engine';
import type { Player } from '../src/engine/player';

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'a1',
  name: 'Spende',
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

const ev = (id: string): NormalizedEvent => ({
  id,
  source: 'streamelements',
  type: 'tip',
  rawType: 'tip',
  amount: 5,
  isTest: false,
  ts: new Date().toISOString(),
});

function setup(mode: 'auto' | 'manual', alerts: Alert[]) {
  const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), triggerMode: mode };
  const played: string[] = [];
  const player = {
    plan: () => ({ tracks: [], totalMs: 0 }),
    play: async (req: { event?: NormalizedEvent }) => {
      played.push(req.event!.id);
    },
  } as unknown as Player;
  const logs: EventLogEntry[] = [];
  const updates: Array<{ id: string; o: EventOutcome }> = [];
  const engine = new AlertEngine(player, () => alerts, () => settings, {
    onLog: (e) => logs.push(e),
    onUpdate: (id, o) => updates.push({ id, o }),
    onState: () => undefined,
    warn: () => undefined,
  });
  return { engine, logs, updates, played, settings };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('Auslösung automatisch / manuell', () => {
  it('Standard ist automatisch', () => {
    expect(DEFAULT_SETTINGS.triggerMode).toBe('auto');
  });

  it('automatisch: Event spielt sofort', async () => {
    const { engine, logs, played } = setup('auto', [alert()]);
    engine.handle(ev('e1'));
    await tick();
    expect(logs[0].outcome.status).toBe('queued');
    expect(played).toEqual(['e1']);
  });

  it('manuell: Event wartet und spielt erst nach Freigabe', async () => {
    const { engine, logs, played } = setup('manual', [alert()]);
    engine.handle(ev('e1'));
    await tick();
    expect(logs[0].outcome.status).toBe('pending');
    expect(engine.pendingCount).toBe(1);
    expect(played).toEqual([]);
    expect(engine.release('e1')).toBe(true);
    await tick();
    expect(played).toEqual(['e1']);
    expect(engine.pendingCount).toBe(0);
  });

  it('manuell: Verwerfen spielt nichts', async () => {
    const { engine, played, updates } = setup('manual', [alert()]);
    engine.handle(ev('e1'));
    expect(engine.dismiss('e1')).toBe(true);
    await tick();
    expect(played).toEqual([]);
    expect(updates.at(-1)?.o.status).toBe('skipped');
  });

  it('Alert-Einstellung übersteuert die globale', async () => {
    const a = setup('manual', [alert({ triggerMode: 'auto' })]);
    a.engine.handle(ev('e1'));
    await tick();
    expect(a.played).toEqual(['e1']);

    const b = setup('auto', [alert({ triggerMode: 'manual' })]);
    b.engine.handle(ev('e2'));
    await tick();
    expect(b.played).toEqual([]);
    expect(b.engine.pendingCount).toBe(1);
  });

  it('Erneut abspielen umgeht die Freigabe', async () => {
    const { engine, played } = setup('manual', [alert()]);
    engine.handle(ev('e1'), undefined, { forcePlay: true });
    await tick();
    expect(played).toEqual(['e1']);
  });
});
