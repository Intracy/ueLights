import type { Rgb } from './types';

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export function clamp(v: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, v));
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const p = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

export function scale(c: Rgb, f: number): Rgb {
  const k = clamp(f, 0, 1);
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/** HSV (h 0–360, s/v 0–1) nach RGB 0–255 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** RGB nach HSV (h 0–360, s/v 0–1) */
export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Farbnamen für Chat-/Kanalpunkte-Farbwahl (deutsch + englisch). */
export const COLOR_WORDS: Record<string, string> = {
  rot: '#ff2a2a', red: '#ff2a2a',
  grün: '#2aff5a', gruen: '#2aff5a', green: '#2aff5a',
  blau: '#2a5aff', blue: '#2a5aff',
  gelb: '#ffd42a', yellow: '#ffd42a',
  orange: '#ff8a1a',
  lila: '#a64dff', violett: '#a64dff', purple: '#a64dff', violet: '#a64dff',
  pink: '#ff4dc4', rosa: '#ff8ad8',
  cyan: '#1ae0ff', türkis: '#1ae0c8', tuerkis: '#1ae0c8', turquoise: '#1ae0c8',
  weiß: '#ffffff', weiss: '#ffffff', white: '#ffffff',
  magenta: '#ff1aff',
};

/**
 * Liest eine Farbe aus einem Text: Hex (#rrggbb / #rgb) oder ein Farbwort.
 * Gibt null zurück, wenn nichts Erlaubtes gefunden wird.
 */
export function parseColorFromText(text: string | undefined): string | null {
  if (!text) return null;
  const hex = text.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
  if (hex) return rgbToHex(hexToRgb(hex[0]));
  const words = text.toLowerCase().split(/[^a-zäöüß]+/);
  for (const w of words) {
    if (w && COLOR_WORDS[w]) return COLOR_WORDS[w];
  }
  return null;
}
