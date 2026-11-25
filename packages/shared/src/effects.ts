import { BLACK, clamp, hexToRgb, hsvToRgb, mix, rgbToHsv, scale } from './color';
import type { AmountMapping, Effect, Rgb } from './types';

export interface RenderContext {
  /** Anzahl LEDs (1 = Gerät ohne Einzel-LED-Steuerung) */
  ledCount: number;
  /** Position des Betrags zwischen min und max der Betragszuordnung (0–1) */
  amountRatio?: number;
  /** Flacker-Schutz: maximale Blitze pro Sekunde */
  maxFlashHz: number;
  /** Abweichende Gesamtdauer (z. B. aus Track oder Betrag) */
  durationMs?: number;
}

export interface RenderedFrame {
  /** Farbe je LED (Länge = ledCount) */
  leds: Rgb[];
  /** Eine repräsentative Farbe für Geräte ohne Einzel-LED-Steuerung */
  solid: Rgb;
}

export function amountRatio(mapping: AmountMapping | undefined, amount: number | undefined): number | undefined {
  if (!mapping || amount === undefined || Number.isNaN(amount)) return undefined;
  if (mapping.max <= mapping.min) return amount >= mapping.max ? 1 : 0;
  return clamp((amount - mapping.min) / (mapping.max - mapping.min));
}

/** Effektive Dauer eines Effekts unter Berücksichtigung von Betrag und Track. */
export function effectiveDuration(effect: Effect, ratio: number | undefined, override?: number): number {
  const base = override && override > 0 ? override : effect.durationMs;
  if (effect.amountMapping?.target === 'duration' && ratio !== undefined) {
    return Math.round(base * (0.5 + ratio));
  }
  return base;
}

/** Tempo mit Flacker-Schutz begrenzen. */
export function safeSpeed(effect: Effect, maxFlashHz: number): number {
  const s = Math.max(0.05, effect.speed || 1);
  if (effect.kind === 'strobe' || effect.kind === 'pulse' || effect.kind === 'colorCycle') {
    return Math.min(s, Math.max(0.1, maxFlashHz));
  }
  return s;
}

function palette(effect: Effect): Rgb[] {
  const cols = effect.colors.length ? effect.colors : ['#ffffff'];
  return cols.map(hexToRgb);
}

function envelope(effect: Effect, t: number, duration: number): number {
  let k = 1;
  if (effect.fadeInMs > 0 && t < effect.fadeInMs) k = Math.min(k, t / effect.fadeInMs);
  if (effect.fadeOutMs > 0 && t > duration - effect.fadeOutMs) {
    k = Math.min(k, Math.max(0, (duration - t) / effect.fadeOutMs));
  }
  return clamp(k);
}

function baseBrightness(effect: Effect, ratio: number | undefined): number {
  const b = clamp(effect.brightness / 100);
  if (effect.amountMapping?.target === 'brightness' && ratio !== undefined) {
    return b * (0.15 + 0.85 * ratio);
  }
  return b;
}

function colorAt(cols: Rgb[], pos: number): Rgb {
  // pos in Farbschritten, weich überblendet
  const n = cols.length;
  if (n === 1) return cols[0];
  const i = Math.floor(pos) % n;
  const f = pos - Math.floor(pos);
  const next = (i + 1) % n;
  // 70 % halten, 30 % überblenden
  return f < 0.7 ? cols[i] : mix(cols[i], cols[next], (f - 0.7) / 0.3);
}

/**
 * Berechnet ein Bild eines Effekts zum Zeitpunkt t (ms seit Effektbeginn).
 * Läuft identisch im Server (echte Lichter) und im Browser (Vorschau, virtuelle Lichter).
 */
export function renderEffect(effect: Effect, t: number, ctx: RenderContext): RenderedFrame {
  const n = Math.max(1, Math.floor(ctx.ledCount));
  const duration = ctx.durationMs ?? effect.durationMs;
  const cols = palette(effect);
  const ratio = ctx.amountRatio;
  const env = envelope(effect, t, duration);
  const bMax = baseBrightness(effect, ratio) * env;
  const bMin = clamp(effect.brightnessMin / 100) * env;
  const speed = safeSpeed(effect, ctx.maxFlashHz);
  const sec = t / 1000;
  const leds: Rgb[] = new Array(n);

  const fillAll = (c: Rgb) => {
    for (let i = 0; i < n; i++) leds[i] = c;
    return { leds, solid: c };
  };

  if (t < 0 || t > duration) return fillAll(BLACK);

  switch (effect.kind) {
    case 'static':
      return fillAll(scale(cols[0], bMax));

    case 'fade': {
      const p = duration > 0 ? (t / duration) * Math.max(1, cols.length - 1) : 0;
      const i = Math.min(cols.length - 1, Math.floor(p));
      const c = cols.length > 1 ? mix(cols[i], cols[Math.min(cols.length - 1, i + 1)], p - i) : cols[0];
      return fillAll(scale(c, bMax));
    }

    case 'pulse': {
      const phase = sec * speed;
      const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2; // 0..1
      const b = bMin + (bMax - bMin) * wave;
      const c = cols[Math.floor(phase) % cols.length];
      return fillAll(scale(c, b));
    }

    case 'strobe': {
      const phase = sec * speed;
      const on = phase - Math.floor(phase) < 0.5;
      const c = cols[Math.floor(phase) % cols.length];
      return fillAll(scale(c, on ? bMax : bMin));
    }

    case 'colorCycle': {
      const c = colorAt(cols, sec * speed);
      return fillAll(scale(c, bMax));
    }

    case 'rainbow': {
      const baseHue = (sec * speed * 360) % 360;
      for (let i = 0; i < n; i++) {
        leds[i] = hsvToRgb(baseHue + (i / n) * 360, 1, bMax);
      }
      return { leds, solid: hsvToRgb(baseHue, 1, bMax) };
    }

    case 'chase': {
      const seg = Math.max(1, Math.round(n * 0.15));
      const head = ((sec * speed) % 1) * (n + seg);
      const c = cols[0];
      const bg = cols[1] ? scale(cols[1], bMin) : scale(c, bMin);
      for (let i = 0; i < n; i++) {
        const d = head - i;
        leds[i] = d >= 0 && d < seg ? scale(c, bMax * (1 - d / seg) ** 0.5) : bg;
      }
      // Geräte ohne Pixel: sanfter Puls
      const wave = (1 - Math.cos(sec * speed * Math.PI * 2)) / 2;
      return { leds, solid: scale(c, bMin + (bMax - bMin) * wave) };
    }

    case 'fill': {
      const level = effect.amountMapping?.target === 'fill' && ratio !== undefined ? ratio : 1;
      const grow = clamp(t / Math.max(1, duration * 0.4));
      const lit = level * grow * n;
      const c = cols[0];
      const bg = cols[1] ? scale(cols[1], bMin) : BLACK;
      for (let i = 0; i < n; i++) {
        if (i < Math.floor(lit)) leds[i] = scale(c, bMax);
        else if (i < lit) leds[i] = scale(c, bMax * (lit - i));
        else leds[i] = bg;
      }
      return { leds, solid: scale(c, bMax * Math.max(0.1, level * grow)) };
    }
  }
  return fillAll(BLACK);
}

/** Einfarbiger Effekt (z. B. Farbwahl aus dem Chat). */
export function solidEffect(color: string, brightness: number, durationMs: number): Effect {
  return {
    id: '__solid',
    name: 'Farbe',
    kind: 'static',
    colors: [color],
    brightness,
    brightnessMin: 0,
    durationMs,
    speed: 1,
    fadeInMs: 150,
    fadeOutMs: 300,
  };
}

/** Helligkeit (0–100) und reine Farbe (volle Helligkeit) aus einer gerenderten Farbe ableiten. */
export function splitBrightness(c: Rgb): { color: Rgb; brightness: number } {
  const { h, s, v } = rgbToHsv(c);
  if (v <= 0.001) return { color: BLACK, brightness: 0 };
  return { color: hsvToRgb(h, s, 1), brightness: Math.round(v * 100) };
}

export function defaultEffect(id: string, name = 'Neuer Effekt'): Effect {
  return {
    id,
    name,
    kind: 'pulse',
    colors: ['#b794ff', '#3de0e8'],
    brightness: 100,
    brightnessMin: 10,
    durationMs: 5000,
    speed: 1,
    fadeInMs: 200,
    fadeOutMs: 500,
  };
}
