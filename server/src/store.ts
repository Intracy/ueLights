import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  type Alert,
  type Effect,
  type EventLogEntry,
  type Group,
  type Light,
  type Settings,
} from '@uelights/shared';
import { seedEffects } from './seed.js';

export interface StoreData {
  version: 1;
  alerts: Alert[];
  effects: Effect[];
  lights: Light[];
  groups: Group[];
  settings: Settings;
  auth: { passwordHash?: string; sessionSecret?: string };
}

/** Tief zusammenführen, damit neue Einstellungsfelder Standardwerte bekommen. */
function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/**
 * Einfache JSON-Datenhaltung mit atomarem Schreiben.
 * Die Datenmengen (Alerts, Effekte, Lichter) sind klein – eine Datenbank ist nicht nötig.
 */
export class Store {
  private file: string;
  private logFile: string;
  data: StoreData;
  log: EventLogEntry[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'store.json');
    this.logFile = path.join(dir, 'events.json');
    this.data = this.load();
    try {
      this.log = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
    } catch {
      this.log = [];
    }
  }

  private load(): StoreData {
    const fresh: StoreData = {
      version: 1,
      alerts: [],
      effects: seedEffects(),
      lights: [],
      groups: [],
      settings: structuredClone(DEFAULT_SETTINGS),
      auth: {},
    };
    if (!fs.existsSync(this.file)) return fresh;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreData>;
      return {
        ...fresh,
        ...parsed,
        settings: deepMerge(structuredClone(DEFAULT_SETTINGS), parsed.settings),
        auth: parsed.auth ?? {},
      };
    } catch (err) {
      const backup = `${this.file}.broken-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`store.json war nicht lesbar, Sicherung unter ${backup}`, err);
      return fresh;
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Änderung übernehmen und verzögert speichern. */
  commit(): void {
    for (const fn of this.listeners) fn();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    }, 200);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    this.writeAtomic(this.logFile, JSON.stringify(this.log));
  }

  addLog(entry: EventLogEntry, max = 500): void {
    this.log.unshift(entry);
    if (this.log.length > max) this.log.length = max;
    this.scheduleLogSave();
  }

  scheduleLogSave(): void {
    if (this.logTimer) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      this.writeAtomic(this.logFile, JSON.stringify(this.log));
    }, 1000);
  }

  private writeAtomic(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
