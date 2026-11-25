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
export class EventPipeline {
  private seen = new Map<string, number>();
  private bundles: PendingBundle[] = [];

  constructor(private bundleWindowMs: () => number) {}

  /** Gibt das Event zurück, das weiterverarbeitet werden soll, oder einen Grund zum Verwerfen. */
  process(res: NormalizeResult, now = Date.now()): { event: NormalizedEvent; drop?: string } {
    const ev = res.event;
    this.gc(now);

    if (this.seen.has(ev.id)) return { event: ev, drop: 'Doppelt empfangen' };
    this.seen.set(ev.id, now);

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
    if (this.seen.size > 2000) {
      for (const [k, t] of this.seen) {
        if (now - t > 10 * 60_000) this.seen.delete(k);
      }
    }
  }
}
