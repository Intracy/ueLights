import { rgbToHex, scale, type Light, type NativeEffect, type NormalizedEvent, type Rgb } from '@uelights/shared';
import type { DriverCapabilities, LightDriver, PlayContext } from './types.js';

/** Virtuelles Licht: zeigt Effekte nur in der Web-App an (Testen ohne Hardware). */
export class VirtualDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: true, color: true, native: false };
  private current: Rgb[] = [];

  constructor(readonly light: Light, private emit: (lightId: string, leds: string[]) => void) {}

  ledCount(): number {
    return Math.max(1, Math.min(600, this.light.config.ledCount ?? 60));
  }

  async probe() {
    return { ok: true, detail: `${this.ledCount()} virtuelle LEDs`, ledCount: this.ledCount() };
  }

  async snapshot() {
    return this.current.slice();
  }

  async restore(raw: unknown) {
    const leds = (raw as Rgb[]) ?? [];
    await this.sendFrame(leds.length ? leds : new Array(this.ledCount()).fill({ r: 0, g: 0, b: 0 }));
  }

  async setColor(c: Rgb, brightness: number) {
    await this.sendFrame(new Array(this.ledCount()).fill(scale(c, brightness / 100)));
  }

  async beginRealtime() {}

  async sendFrame(leds: Rgb[]) {
    this.current = leds;
    this.emit(this.light.id, leds.map(rgbToHex));
  }

  async listNative(): Promise<NativeEffect[]> {
    return [];
  }

  async playNative(_n: NativeEffect, _ctx: PlayContext) {}

  async off() {
    await this.sendFrame(new Array(this.ledCount()).fill({ r: 0, g: 0, b: 0 }));
  }
}

/** Webhook: schickt Alert- und Farbinformationen per HTTP POST an eine lokale Adresse. */
export class WebhookDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: false, color: true, native: true };

  constructor(readonly light: Light) {}

  private async post(body: Record<string, unknown>) {
    const url = this.light.config.url;
    if (!url) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'uelights', light: this.light.name, ...body }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  ledCount() {
    return 1;
  }

  async probe() {
    return { ok: !!this.light.config.url, detail: this.light.config.url || 'Keine URL hinterlegt' };
  }

  async snapshot() {
    return null;
  }

  async restore() {
    await this.post({ type: 'restore' });
  }

  async setColor(c: Rgb, brightness: number) {
    await this.post({ type: 'color', color: rgbToHex(c), brightness: Math.round(brightness) });
  }

  async listNative(): Promise<NativeEffect[]> {
    return [{ id: 'trigger', name: 'Webhook auslösen', kind: 'webhook' }];
  }

  async playNative(_n: NativeEffect, ctx: PlayContext) {
    const ev: NormalizedEvent | undefined = ctx.event;
    await this.post({
      type: 'alert',
      alert: ctx.alertName,
      event: ev ? { type: ev.type, user: ev.user, amount: ev.amount, message: ev.message, currency: ev.currency } : null,
    });
  }

  async off() {
    await this.post({ type: 'off' });
  }
}
