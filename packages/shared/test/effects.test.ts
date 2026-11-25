import { describe, expect, it } from 'vitest';
import { amountRatio, defaultEffect, parseColorFromText, renderEffect, safeSpeed, splitBrightness, type Effect } from '../src';

describe('Effekte', () => {
  it('Flacker-Schutz begrenzt Strobe auf maxFlashHz', () => {
    const e: Effect = { ...defaultEffect('x'), kind: 'strobe', speed: 12 };
    expect(safeSpeed(e, 3)).toBe(3);
    const rb: Effect = { ...defaultEffect('x'), kind: 'rainbow', speed: 12 };
    expect(safeSpeed(rb, 3)).toBe(12);
  });

  it('zählt Helligkeitswechsel pro Sekunde höchstens maxFlashHz', () => {
    const e: Effect = { ...defaultEffect('x'), kind: 'strobe', speed: 20, durationMs: 5000, fadeInMs: 0, fadeOutMs: 0, brightnessMin: 0 };
    let flashes = 0;
    let prevOn = false;
    for (let t = 0; t < 1000; t += 5) {
      const on = renderEffect(e, t, { ledCount: 1, maxFlashHz: 3 }).solid.r > 10;
      if (on && !prevOn) flashes++;
      prevOn = on;
    }
    expect(flashes).toBeLessThanOrEqual(3);
  });

  it('liefert pro LED ein Bild und außerhalb der Dauer Schwarz', () => {
    const e: Effect = { ...defaultEffect('x'), kind: 'chase', durationMs: 2000 };
    const f = renderEffect(e, 500, { ledCount: 100, maxFlashHz: 3 });
    expect(f.leds).toHaveLength(100);
    const after = renderEffect(e, 3000, { ledCount: 10, maxFlashHz: 3 });
    expect(after.solid).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('Betrag steuert den Füllstand', () => {
    const e: Effect = { ...defaultEffect('x'), kind: 'fill', colors: ['#ffffff'], fadeInMs: 0, fadeOutMs: 0, durationMs: 1000, amountMapping: { target: 'fill', min: 0, max: 100 } };
    const ratio = amountRatio(e.amountMapping, 50);
    expect(ratio).toBe(0.5);
    const f = renderEffect(e, 900, { ledCount: 10, maxFlashHz: 3, amountRatio: ratio });
    const lit = f.leds.filter((c) => c.r > 128).length;
    expect(lit).toBe(5);
  });

  it('liest Farben aus Chat-Text', () => {
    expect(parseColorFromText('bitte blau!')).toBe('#2a5aff');
    expect(parseColorFromText('Farbe #FF00ff')).toBe('#ff00ff');
    expect(parseColorFromText('egal')).toBeNull();
  });

  it('trennt Farbe und Helligkeit', () => {
    const { color, brightness } = splitBrightness({ r: 128, g: 0, b: 0 });
    expect(brightness).toBe(50);
    expect(Math.round(color.r)).toBe(255);
  });
});
