/** Kurze, zufällige IDs (Browser und Node). */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return prefix ? `${prefix}_${s}` : s;
}
