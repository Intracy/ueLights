import type { EventType, NormalizedEvent, Settings } from '@uelights/shared';

type Obj = Record<string, unknown>;

const TYPE_MAP: Record<string, EventType> = {
  tip: 'tip',
  charityCampaignDonation: 'tip',
  cheer: 'cheer',
  cheerPurchase: 'cheer',
  subscriber: 'subscriber',
  sponsor: 'subscriber',
  communityGiftPurchase: 'giftSub',
  raid: 'raid',
  host: 'raid',
  follow: 'follow',
  follower: 'follow',
  channelPointsRedemption: 'channelPoints',
  redemption: 'channelPoints',
  superchat: 'superchat',
  merch: 'merch',
  purchase: 'merch',
  hypetrainStart: 'hypetrain',
  hypetrainProgress: 'hypetrain',
  hypetrainEnd: 'hypetrain',
};

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Spenden in Kanalwährung umrechnen (feste Kurse, kein Online-Abruf). */
export function convertCurrency(
  amount: number | undefined,
  currency: string | undefined,
  s: Settings['events'],
): { amount?: number; skip?: boolean } {
  if (amount === undefined) return {};
  if (!currency || currency.toUpperCase() === s.channelCurrency.toUpperCase()) return { amount };
  if (s.foreignCurrency === 'ignore') return { skip: true };
  if (s.foreignCurrency === 'original') return { amount };
  const rate = s.fxRates[currency.toUpperCase()];
  if (rate === undefined) return { amount };
  return { amount: Math.round(amount * rate * 100) / 100 };
}

export interface NormalizeResult {
  event: NormalizedEvent;
  /** Interne Hinweise für die Gift-Bündelung */
  gift?: { sender?: string; isGifted: boolean; isBundle: boolean; count: number };
  skipReason?: string;
}

/**
 * Wandelt eine StreamElements-Aktivität (channel.activities) in ein NormalizedEvent.
 * Die Feldnamen werden defensiv gelesen, weil StreamElements sie je Plattform leicht unterschiedlich liefert.
 */
export function normalizeActivity(msg: Obj, settings: Settings['events']): NormalizeResult | null {
  const act = isObj(msg.data) ? msg.data : msg;
  const rawType = str(act.type) ?? 'unknown';
  const d: Obj = isObj(act.data) ? act.data : {};
  const type: EventType = TYPE_MAP[rawType] ?? 'other';
  const id =
    str(act.activityId) ?? str(act._id) ?? str(msg.id) ?? `se_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const user = str(d.displayName) ?? str(d.username) ?? str(d.sender) ?? str(d.name);
  const message = str(d.message) ?? str(d.text);
  const currency = str(d.currency);
  let amount = num(d.amount) ?? num(d.count) ?? num(d.quantity);
  let originalAmount: number | undefined;
  let skipReason: string | undefined;

  if (type === 'tip' || type === 'superchat') {
    originalAmount = amount;
    const conv = convertCurrency(amount, currency, settings);
    if (conv.skip) skipReason = `Spende in Fremdwährung ${currency} wird ignoriert`;
    amount = conv.amount;
  }
  if (type === 'raid' && amount === undefined) amount = num(d.viewers);

  const event: NormalizedEvent = {
    id,
    source: 'streamelements',
    type,
    rawType,
    provider: str(act.provider),
    user,
    amount,
    originalAmount,
    currency,
    message,
    reward: str(d.redemption) ?? str(d.title) ?? str(d.item) ?? str(d.rewardTitle),
    subTier: str(d.tier),
    isTest: act.isMock === true || d.isMock === true || act.isTest === true || msg.isMock === true,
    ts: str(act.createdAt) ?? str(msg.ts) ?? new Date().toISOString(),
    raw: msg,
  };

  let gift: NormalizeResult['gift'];
  if (rawType === 'communityGiftPurchase') {
    gift = { sender: user, isGifted: true, isBundle: true, count: amount ?? 1 };
    event.amount = amount ?? 1;
  } else if (rawType === 'subscriber' && (d.gifted === true || str(d.sender))) {
    const sender = str(d.sender) ?? user;
    gift = { sender, isGifted: true, isBundle: false, count: 1 };
    // Einzelnes Geschenk-Abo zählt als Gift-Sub mit Anzahl 1
    event.type = 'giftSub';
    event.user = sender;
    event.amount = 1;
  }
  return { event, gift, skipReason };
}

/** Wandelt ein channel.tips-Event (nur wenn das Topic zusätzlich abonniert ist). */
export function normalizeTip(msg: Obj, settings: Settings['events']): NormalizeResult | null {
  const data = isObj(msg.data) ? msg.data : {};
  const donation = isObj(data.donation) ? data.donation : data;
  const userObj = isObj(donation.user) ? donation.user : {};
  const amountRaw = num(donation.amount);
  const currency = str(donation.currency);
  const conv = convertCurrency(amountRaw, currency, settings);
  const event: NormalizedEvent = {
    id: str(data._id) ?? str(donation._id) ?? str(donation.transactionId) ?? str(msg.id) ?? `tip_${Date.now()}`,
    source: 'streamelements',
    type: 'tip',
    rawType: 'tip',
    user: str(userObj.username) ?? str(donation.username),
    amount: conv.amount,
    originalAmount: amountRaw,
    currency,
    message: str(donation.message),
    isTest: false,
    ts: str(data.createdAt) ?? str(msg.ts) ?? new Date().toISOString(),
    raw: msg,
  };
  return { event, skipReason: conv.skip ? `Spende in Fremdwährung ${currency} wird ignoriert` : undefined };
}

/** Wandelt eine Chat-Nachricht (channel.chat.message). */
export function normalizeChat(msg: Obj): NormalizeResult | null {
  const data = isObj(msg.data) ? msg.data : {};
  const inner = isObj(data.data) ? data.data : data;
  const text = str(inner.text) ?? str(inner.message) ?? str((inner as Obj).msg);
  if (!text) return null;
  const user = str(inner.displayName) ?? str(inner.nick) ?? str(inner.username) ?? str(inner.user);
  return {
    event: {
      id: str(inner.msgId) ?? str(inner.id) ?? str(msg.id) ?? `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      source: 'streamelements',
      type: 'chatMessage',
      rawType: 'chat',
      provider: str(data.provider) ?? str(inner.provider),
      user,
      message: text,
      isTest: false,
      ts: str(msg.ts) ?? new Date().toISOString(),
      raw: msg,
    },
  };
}
