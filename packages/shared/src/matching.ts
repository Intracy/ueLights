import type { Alert, AmountCondition, NormalizedEvent, Tier } from './types';

/** Rundet auf Cent, um Gleitkomma-Fehler (4,2 vs 4,199999) zu vermeiden. */
function cents(n: number): number {
  return Math.round(n * 100);
}

export function matchAmount(cond: AmountCondition, amount: number | undefined): boolean {
  if (cond.mode === 'any') return true;
  if (amount === undefined || Number.isNaN(amount)) return false;
  const a = cents(amount);
  switch (cond.mode) {
    case 'exact':
      return a === cents(cond.value);
    case 'range':
      return a >= cents(cond.min) && a <= cents(cond.max);
    case 'min':
      return a >= cents(cond.min);
  }
}

/** Höher = spezifischer. exact > range > min > any */
export function amountSpecificity(cond: AmountCondition): number {
  switch (cond.mode) {
    case 'exact':
      return 3;
    case 'range':
      return 2;
    case 'min':
      return 1;
    default:
      return 0;
  }
}

export function describeAmount(cond: AmountCondition, unit = ''): string {
  const f = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + (unit ? ` ${unit}` : '');
  switch (cond.mode) {
    case 'any':
      return 'jeder Betrag';
    case 'exact':
      return `genau ${f(cond.value)}`;
    case 'range':
      return `${f(cond.min)} – ${f(cond.max)}`;
    case 'min':
      return `ab ${f(cond.min)}`;
  }
}

/** Passt die Stufe? Bei mehreren passenden gewinnt die spezifischste, dann die höhere Untergrenze. */
export function selectTier(tiers: Tier[], amount: number | undefined): Tier | undefined {
  const matching = tiers.filter((t) => matchAmount(t.amount, amount));
  matching.sort((a, b) => {
    const s = amountSpecificity(b.amount) - amountSpecificity(a.amount);
    if (s !== 0) return s;
    return lowerBound(b.amount) - lowerBound(a.amount);
  });
  return matching[0];
}

function lowerBound(c: AmountCondition): number {
  if (c.mode === 'exact') return c.value;
  if (c.mode === 'range' || c.mode === 'min') return c.min;
  return -Infinity;
}

export interface AlertMatch {
  alert: Alert;
  tier?: Tier;
  /** Für Konfliktauflösung */
  specificity: number;
  /** Position in der Alert-Liste (kleiner = höhere Priorität) */
  priority: number;
}

/** Prüft die Bedingungen eines Alerts (ohne Cooldown). */
export function alertMatches(alert: Alert, ev: NormalizedEvent): AlertMatch | null {
  if (!alert.enabled) return null;
  if (alert.trigger !== ev.type) return null;
  const c = alert.conditions;
  if (ev.isTest && !c.allowTest) return null;
  if (c.provider && ev.provider && c.provider.toLowerCase() !== ev.provider.toLowerCase()) return null;
  if (c.textContains && !(ev.message ?? '').toLowerCase().includes(c.textContains.toLowerCase())) return null;
  if (c.reward && (ev.reward ?? '').trim().toLowerCase() !== c.reward.trim().toLowerCase()) return null;
  if (c.subTier && ev.subTier && c.subTier !== ev.subTier) return null;

  let specificity = 0;
  if (c.textContains) specificity += 1;
  if (c.reward) specificity += 2;

  if (alert.mode === 'tiers') {
    if (!matchAmount(c.amount, ev.amount)) return null;
    const tier = selectTier(alert.tiers, ev.amount);
    if (!tier) return null;
    specificity += amountSpecificity(tier.amount) * 10;
    return { alert, tier, specificity, priority: 0 };
  }
  if (!matchAmount(c.amount, ev.amount)) return null;
  specificity += amountSpecificity(c.amount) * 10;
  return { alert, specificity, priority: 0 };
}

/**
 * Wählt die auszuführenden Alerts:
 * – genau ein "exklusiver" Alert (spezifischster, bei Gleichstand die höhere Position in der Liste)
 * – plus alle passenden Alerts mit "zusätzlich ausführen".
 */
export function pickAlerts(alerts: Alert[], ev: NormalizedEvent): AlertMatch[] {
  const matches: AlertMatch[] = [];
  alerts.forEach((a, i) => {
    const m = alertMatches(a, ev);
    if (m) matches.push({ ...m, priority: i });
  });
  const exclusive = matches
    .filter((m) => m.alert.overlap === 'exclusive')
    .sort((a, b) => b.specificity - a.specificity || a.priority - b.priority);
  const additive = matches.filter((m) => m.alert.overlap === 'additive');
  return [...(exclusive[0] ? [exclusive[0]] : []), ...additive];
}

/** Prüft Stufen auf Lücken und Überschneidungen (nur Bereiche/ab). */
export function validateTiers(tiers: Tier[]): string[] {
  const problems: string[] = [];
  const ranges = tiers
    .filter((t) => t.amount.mode === 'range' || t.amount.mode === 'min')
    .map((t) => ({
      label: t.label,
      min: (t.amount as { min: number }).min,
      max: t.amount.mode === 'range' ? t.amount.max : Infinity,
    }))
    .sort((a, b) => a.min - b.min);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.max < r.min) problems.push(`„${r.label}“: Obergrenze liegt unter der Untergrenze`);
    const next = ranges[i + 1];
    if (!next) continue;
    if (cents(next.min) <= cents(r.max)) problems.push(`„${r.label}“ überschneidet sich mit „${next.label}“`);
    else if (cents(next.min) - cents(r.max) > 1) problems.push(`Lücke zwischen „${r.label}“ und „${next.label}“`);
  }
  return problems;
}
