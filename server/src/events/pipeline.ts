import type { NormalizedEvent } from '@uelights/shared';
import type { NormalizeResult } from './normalize.js';

interface PendingBundle {
  sender: string;
  remaining: number;
  expires: number;
}

/**
 * Vorverarbeitung vor der Alert-Engine:
 * – Doppelte Events verwerfen (gleiche ID über mehrere Topics)
 * – Gift-Bomben bündeln: Sammel-Event zählt, die folgenden Einzel-Geschenke werden unterdrückt
 */
/** Fingerabdruck, an dem dasselbe Ereignis aus StreamElements und Twitch erkannt wird */
export function eventFingerprint(ev: NormalizedEvent): string {
  const user = (ev.user ?? '').trim().toLowerCase();
  const detail =
    ev.type === 'channelPoints'
      ? (ev.reward ?? '').trim().toLowerCase()
      : ['cheer', 'raid', 'giftSub', 'tip'].includes(ev.type)
        ? String(ev.amount ?? '')
        : '';
  return `${ev.type}|${user}|${detail}`;
}

const CROSS_SOURCE_MS = 15_000;

export class EventPipeline {
  private seen = new Map<string, number>();
  private prints = new Map<string, { source: string; at: number }>();
  private bundles: PendingBundle[] = [];

  constructor(private bundleWindowMs: () => number) {}

  /** Gibt das Event zurück, das weiterverarbeitet werden soll, oder einen Grund zum Verwerfen. */
  process(res: NormalizeResult, now = Date.now()): { event: NormalizedEvent; drop?: string } {
    const ev = res.event;
    this.gc(now);

    if (this.seen.has(ev.id)) return { event: ev, drop: 'Doppelt empfangen' };
    this.seen.set(ev.id, now);

    // Dasselbe Ereignis über zwei Quellen (StreamElements und Twitch direkt) nur einmal auslösen
    if (ev.source === 'streamelements' || ev.source === 'twitch') {
      const fp = eventFingerprint(ev);
      const prev = this.prints.get(fp);
      if (prev && prev.source !== ev.source && now - prev.at < CROSS_SOURCE_MS) {
        return { event: ev, drop: `Schon über ${prev.source === 'twitch' ? 'Twitch' : 'StreamElements'} empfangen` };
      }
      this.prints.set(fp, { source: ev.source, at: now });
    }

    if (res.gift?.isBundle && res.gift.sender) {
      this.bundles.push({
        sender: res.gift.sender.toLowerCase(),
        remaining: res.gift.count,
        expires: now + this.bundleWindowMs(),
      });
    } else if (res.gift?.isGifted && !res.gift.isBundle && res.gift.sender) {
      const b = this.bundles.find((x) => x.sender === res.gift!.sender!.toLowerCase() && x.remaining > 0);
      if (b) {
        b.remaining -= 1;
        return { event: ev, drop: 'Teil einer Gift-Bombe (gebündelt)' };
      }
    }
    if (res.skipReason) return { event: ev, drop: res.skipReason };
    return { event: ev };
  }

  private gc(now: number): void {
    this.bundles = this.bundles.filter((b) => b.expires > now && b.remaining > 0);
    for (const [k, v] of this.prints) if (now - v.at > CROSS_SOURCE_MS) this.prints.delete(k);
    if (this.seen.size > 2000) {
      for (const [k, t] of this.seen) {
        if (now - t > 10 * 60_000) this.seen.delete(k);
      }
    }
  }
}
