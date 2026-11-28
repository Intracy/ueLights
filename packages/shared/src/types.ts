// ---------------------------------------------------------------------------
// ueLights – gemeinsame Typen für Server und Web-App
// ---------------------------------------------------------------------------

/** Normalisierte Event-Typen, unabhängig von StreamElements. */
export type EventType =
  | 'tip'
  | 'cheer'
  | 'subscriber'
  | 'giftSub'
  | 'raid'
  | 'follow'
  | 'channelPoints'
  | 'chatMessage'
  | 'superchat'
  | 'merch'
  | 'hypetrain'
  | 'other';

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  tip: 'Spende (Tip)',
  cheer: 'Bits (Cheer)',
  subscriber: 'Sub / Resub',
  giftSub: 'Gift-Subs',
  raid: 'Raid',
  follow: 'Follow',
  channelPoints: 'Kanalpunkte',
  chatMessage: 'Chat-Nachricht / Befehl',
  superchat: 'Superchat',
  merch: 'Merch',
  hypetrain: 'Hype-Train',
  other: 'Sonstiges',
};

/** Welche Einheit "amount" je Event-Typ hat (für Anzeige und Stufen). */
export const EVENT_AMOUNT_UNIT: Partial<Record<EventType, string>> = {
  tip: '€',
  superchat: '€',
  cheer: 'Bits',
  giftSub: 'Subs',
  raid: 'Zuschauer',
  subscriber: 'Monate',
};

export interface NormalizedEvent {
  id: string;
  source: 'streamelements' | 'test' | 'manual';
  type: EventType;
  /** Original-Typ der Quelle, z. B. "communityGiftPurchase" */
  rawType: string;
  provider?: string;
  user?: string;
  /** Betrag (Spende in Kanalwährung umgerechnet, Bits, Anzahl Subs, Raid-Zuschauer …) */
  amount?: number;
  /** Originalbetrag vor Umrechnung */
  originalAmount?: number;
  currency?: string;
  message?: string;
  /** Name der Kanalpunkte-Belohnung */
  reward?: string;
  /** Sub-Stufe: "1000" | "2000" | "3000" | "prime" */
  subTier?: string;
  isTest: boolean;
  /** ISO-Zeitstempel des Ereignisses */
  ts: string;
  raw?: unknown;
}

// ----------------------------- Farben & Effekte -----------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type EffectKind =
  | 'static'
  | 'pulse'
  | 'strobe'
  | 'colorCycle'
  | 'rainbow'
  | 'chase'
  | 'fill'
  | 'fade';

export const EFFECT_KIND_LABELS: Record<EffectKind, string> = {
  static: 'Statische Farbe',
  pulse: 'Puls',
  strobe: 'Blitz / Strobe',
  colorCycle: 'Farbwechsel',
  rainbow: 'Regenbogen',
  chase: 'Lauflicht',
  fill: 'Füllstand',
  fade: 'Überblenden',
};

/** Effekte, die nur auf Lichtern mit Einzel-LED-Steuerung sinnvoll laufen. */
export const PIXEL_ONLY_KINDS: EffectKind[] = ['chase', 'fill'];

export interface AmountMapping {
  /** Was der Betrag steuert */
  target: 'brightness' | 'fill' | 'duration';
  /** Betrag, der 0 % entspricht */
  min: number;
  /** Betrag, der 100 % entspricht */
  max: number;
}

export interface Effect {
  id: string;
  name: string;
  kind: EffectKind;
  /** Hex-Farben, z. B. "#b794ff" */
  colors: string[];
  /** Helligkeit 0–100 */
  brightness: number;
  /** Untergrenze der Helligkeit bei Puls/Strobe (0–100) */
  brightnessMin: number;
  durationMs: number;
  /** Tempo: Wiederholungen pro Sekunde (Puls/Strobe/Farbwechsel/Lauflicht) */
  speed: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Betrag als Parameter (optional) */
  amountMapping?: AmountMapping;
}

// ----------------------------- Lichter -------------------------------------

export type ConnectorType = 'twinkly' | 'govee' | 'amaran' | 'hue' | 'homeassistant' | 'virtual' | 'webhook';

export const CONNECTOR_LABELS: Record<ConnectorType, string> = {
  twinkly: 'Twinkly',
  govee: 'Govee',
  amaran: 'amaran',
  hue: 'Philips Hue',
  homeassistant: 'Home Assistant',
  virtual: 'Virtuell',
  webhook: 'Webhook',
};

export interface NativeEffect {
  id: string;
  name: string;
  /** Art des Hersteller-Effekts, z. B. "movie", "effect", "scene", "preset", "ptReal", "ha-effect" */
  kind: string;
  /** Zusatzdaten, die der Konnektor zum Abspielen braucht */
  data?: Record<string, unknown>;
}

export type RestState =
  | { mode: 'snapshot' }
  | { mode: 'off' }
  | { mode: 'color'; color: string; brightness: number }
  | { mode: 'native'; nativeId: string };

export interface LightConfig {
  // twinkly
  host?: string;
  channelOrder?: 'RGB' | 'GRB' | 'RGBW' | 'WRGB';
  // govee
  ip?: string;
  sku?: string;
  // amaran
  nodeId?: string;
  // hue: Ressource auf der Bridge (Lampe oder Raum/Zone)
  hueId?: string;
  hueType?: 'light' | 'grouped_light';
  // homeassistant
  entityId?: string;
  // virtual
  ledCount?: number;
  // webhook
  url?: string;
}

export interface Light {
  id: string;
  name: string;
  connector: ConnectorType;
  config: LightConfig;
  /** "deco" = darf von Alerts gesteuert werden; "scene" = Bildlicht, für Alerts gesperrt */
  role: 'deco' | 'scene';
  restState: RestState;
  nativeEffects: NativeEffect[];
  /** Vom Gerät gemeldete LED-Anzahl (Pixel-Geräte) */
  ledCount?: number;
  enabled: boolean;
}

export interface Group {
  id: string;
  name: string;
  lightIds: string[];
}

// ----------------------------- Alerts --------------------------------------

export type AmountCondition =
  | { mode: 'any' }
  | { mode: 'exact'; value: number }
  | { mode: 'range'; min: number; max: number }
  | { mode: 'min'; min: number };

export type EffectRef =
  | { type: 'own'; effectId: string }
  | { type: 'native'; nativeId: string }
  /** Farbe aus der Chat-Nachricht / Kanalpunkte-Eingabe lesen */
  | { type: 'eventColor'; fallback: string; brightness: number };

export type TrackTarget = { kind: 'light'; lightId: string } | { kind: 'group'; groupId: string };

export interface Track {
  id: string;
  target: TrackTarget;
  effect: EffectRef;
  /** Start relativ zum Alert-Beginn */
  offsetMs: number;
  /** Optional abweichende Dauer; sonst Effektdauer */
  durationMs?: number;
}

export interface Tier {
  id: string;
  label: string;
  amount: AmountCondition;
  tracks: Track[];
}

export interface AlertConditions {
  amount: AmountCondition;
  /** Nachricht muss diesen Text enthalten (Groß/Klein egal) */
  textContains?: string;
  /** Name der Kanalpunkte-Belohnung */
  reward?: string;
  /** Plattform, z. B. "twitch" */
  provider?: string;
  /** Sub-Stufe */
  subTier?: string;
  /** Testevents aus dem StreamElements-Dashboard zulassen */
  allowTest: boolean;
}

export interface Alert {
  id: string;
  name: string;
  enabled: boolean;
  trigger: EventType;
  conditions: AlertConditions;
  mode: 'single' | 'tiers';
  tracks: Track[];
  tiers: Tier[];
  after: 'restore' | 'hold';
  cooldownMs: number;
  overlap: 'exclusive' | 'additive';
  /** Auslösung: wie global eingestellt, immer automatisch oder immer nach manueller Freigabe */
  triggerMode?: 'inherit' | 'auto' | 'manual';
}

// ----------------------------- Einstellungen -------------------------------

export interface Settings {
  streamelements: {
    enabled: boolean;
    jwt: string;
    channelId: string;
    topics: { activities: boolean; tips: boolean; chat: boolean };
  };
  homeassistant: { enabled: boolean; url: string; token: string };
  amaran: {
    enabled: boolean;
    url: string;
    clientId: string;
    /** Schlüssel aus der amaran-OpenAPI-Freischaltung; signiert jede Anfrage (bleibt lokal) */
    apiKey: string;
    /** Skalierung der Intensität (100 = Prozent, 1000 = Promille) */
    intensityScale: number;
    presetCommand: string;
    sceneCommand: string;
  };
  hue: {
    enabled: boolean;
    bridgeIp: string;
    /** Application Key aus der Kopplung (geheim) */
    appKey: string;
    clientKey: string;
    /** SHA-256-Fingerabdruck des Bridge-Zertifikats, beim Koppeln gemerkt */
    certFingerprint: string;
  };
  safety: {
    maxFlashHz: number;
    staleEventSec: number;
    queueMax: number;
    paused: boolean;
    quietHours: { enabled: boolean; from: string; to: string };
    /** Bildlicht-Sperre: Lichter mit Rolle "scene" nie steuern */
    lockSceneLights: boolean;
  };
  events: {
    giftBundleWindowMs: number;
    channelCurrency: string;
    /** Feste Umrechnungskurse in Kanalwährung, z. B. { USD: 0.92 } */
    fxRates: Record<string, number>;
    foreignCurrency: 'convert' | 'original' | 'ignore';
  };
  /** Maximale Befehle pro Sekunde für Lichter ohne Echtzeit-Modus */
  /** auto = eingehende Events lösen Alerts sofort aus; manual = Alerts warten auf Freigabe im Live-Feed */
  triggerMode: 'auto' | 'manual';
  colorCommandRate: number;
  /** Bildwiederholrate für Echtzeit-Lichter */
  realtimeFps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  streamelements: {
    enabled: false,
    jwt: '',
    channelId: '',
    topics: { activities: true, tips: false, chat: true },
  },
  homeassistant: { enabled: false, url: 'http://homeassistant.local:8123', token: '' },
  amaran: {
    enabled: false,
    url: 'ws://192.168.178.20:33782/ws',
    clientId: 'uelights',
    apiKey: '',
    intensityScale: 1000,
    presetCommand: 'set_preset',
    sceneCommand: 'set_scene',
  },
  hue: { enabled: false, bridgeIp: '', appKey: '', clientKey: '', certFingerprint: '' },
  safety: {
    maxFlashHz: 3,
    staleEventSec: 30,
    queueMax: 10,
    paused: false,
    quietHours: { enabled: false, from: '23:00', to: '08:00' },
    lockSceneLights: true,
  },
  events: {
    giftBundleWindowMs: 15000,
    channelCurrency: 'EUR',
    fxRates: { USD: 0.92, GBP: 1.17, CHF: 1.06 },
    foreignCurrency: 'convert',
  },
  triggerMode: 'auto',
  colorCommandRate: 5,
  realtimeFps: 25,
};

// ----------------------------- Laufzeit / Live -----------------------------

export type EventOutcome =
  | { status: 'pending'; alertIds: string[]; tierLabel?: string }
  | { status: 'queued'; alertIds: string[]; tierLabel?: string }
  | { status: 'playing'; alertIds: string[]; tierLabel?: string }
  | { status: 'done'; alertIds: string[]; tierLabel?: string }
  | { status: 'skipped'; reason: string };

export interface EventLogEntry {
  event: NormalizedEvent;
  outcome: EventOutcome;
  alertNames: string[];
  receivedAt: string;
}

export interface ConnectionStatus {
  id: string;
  label: string;
  state: 'ok' | 'connecting' | 'error' | 'disabled';
  detail?: string;
}

export interface NowPlaying {
  alertNames: string[];
  tierLabel?: string;
  eventSummary: string;
  startedAt: number;
  durationMs: number;
  lights: string[];
}

export interface LiveState {
  connections: ConnectionStatus[];
  nowPlaying: NowPlaying | null;
  queueLength: number;
  pendingCount: number;
  triggerMode: 'auto' | 'manual';
  paused: boolean;
}

export type LiveMessage =
  | { type: 'state'; state: LiveState }
  | { type: 'event'; entry: EventLogEntry }
  | { type: 'eventUpdate'; eventId: string; outcome: EventOutcome }
  | { type: 'virtualFrame'; lightId: string; leds: string[] }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

export interface Backup {
  version: 1;
  exportedAt: string;
  alerts: Alert[];
  effects: Effect[];
  lights: Light[];
  groups: Group[];
  settings: Omit<Settings, 'streamelements' | 'homeassistant'> & {
    streamelements: Omit<Settings['streamelements'], 'jwt'>;
    homeassistant: Omit<Settings['homeassistant'], 'token'>;
  };
}
