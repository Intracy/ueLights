#!/usr/bin/env node
// Legt Demo-Daten an (Lichter, Gruppen, Alerts, Effekte, Protokoll) – für Screenshots und zum Ausprobieren.
// Aufruf: node scripts/demo-data.mjs ./demo-data   →   DATA_DIR=./demo-data UELIGHTS_DISABLE_AUTH=1 npm start
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? './demo-data');
fs.mkdirSync(dir, { recursive: true });

const fx = (id, name, kind, colors, extra = {}) => ({
  id, name, kind, colors, brightness: 100, brightnessMin: 10, durationMs: 5000, speed: 1, fadeInMs: 200, fadeOutMs: 500, ...extra,
});

const effects = [
  fx('fx_puls_violett', 'Puls Violett', 'pulse', ['#b794ff'], { durationMs: 4000, brightnessMin: 15 }),
  fx('fx_blitz_weiss', 'Blitz Weiß', 'strobe', ['#ffffff'], { durationMs: 2500, speed: 3, brightnessMin: 0, fadeInMs: 0 }),
  fx('fx_regenbogen', 'Regenbogen', 'rainbow', ['#ff0000'], { durationMs: 6000, speed: 0.5, brightness: 90 }),
  fx('fx_lauflicht_cyan', 'Lauflicht Cyan', 'chase', ['#3de0e8', '#2a0a4f'], { speed: 0.8 }),
  fx('fx_fuellstand_betrag', 'Füllstand nach Betrag', 'fill', ['#7cf29c', '#1b1727'], { durationMs: 6000, fadeInMs: 0, amountMapping: { target: 'fill', min: 1, max: 50 } }),
  fx('fx_farbwechsel', 'Farbwechsel Violett/Cyan/Pink', 'colorCycle', ['#b794ff', '#3de0e8', '#ff5fc8'], { durationMs: 6000, brightnessMin: 0 }),
  fx('fx_bits_glow', 'Bits-Glühen (Betrag = Helligkeit)', 'pulse', ['#ff5fc8', '#b794ff'], { durationMs: 5000, speed: 0.7, amountMapping: { target: 'brightness', min: 100, max: 5000 } }),
  fx('fx_raid_welle', 'Raid-Welle', 'fade', ['#3de0e8', '#b794ff', '#ff5fc8'], { durationMs: 7000 }),
];

const L = (id, name, connector, config, natives = [], extra = {}) => ({
  id, name, connector, config, role: 'deco', restState: { mode: 'snapshot' }, nativeEffects: natives, enabled: true, ...extra,
});
const nat = (kind, names) => names.map((n, i) => ({ id: `${kind}:${i}`, name: n, kind, data: { id: i } }));

const lights = [
  L('li_virt_kette', 'Virtuelle Kette (Baum)', 'virtual', { ledCount: 120 }, [], { restState: { mode: 'off' } }),
  L('li_virt_leiste', 'Virtuelle Leiste (Schreibtisch)', 'virtual', { ledCount: 60 }, [], { restState: { mode: 'off' } }),
  L('li_twinkly', 'Twinkly Strings HD', 'twinkly', { host: '192.168.178.50' }, nat('movie', ['Glitzer', 'Schneefall', 'Polarlicht', 'Feuerwerk', 'Candy Cane']), { ledCount: 400 }),
  L('li_govee_regal', 'Govee Regal', 'govee', { ip: '192.168.178.61', sku: 'H6076' }, nat('scene', ['Aurora', 'Wald', 'Sonnenuntergang', 'Party', 'Gewitter', 'Kerzenschein'])),
  L('li_govee_tisch', 'Govee Schreibtisch', 'govee', { ip: '192.168.178.62', sku: 'H61A8' }, nat('scene', ['Gaming', 'Neon', 'Ozean'])),
  L('li_amaran_deko', 'amaran 60x Deko', 'amaran', { nodeId: 'A1B2C3' }, nat('effect', ['Fire', 'Lightning', 'Cop Car', 'TV', 'Party', 'Pulsing'])),
  L('li_amaran_key', 'amaran Key (Bildlicht)', 'amaran', { nodeId: 'D4E5F6' }, [], { role: 'scene' }),
  L('li_ha_lampe', 'Stehlampe (Home Assistant)', 'homeassistant', { entityId: 'light.stehlampe' }, nat('ha-effect', ['Colorloop', 'Candle', 'Sunrise'])),
];

const groups = [
  { id: 'grp_hintergrund', name: 'Hintergrund', lightIds: ['li_twinkly', 'li_govee_regal', 'li_virt_kette'] },
  { id: 'grp_alle_deko', name: 'Alle Deko-Lichter', lightIds: ['li_twinkly', 'li_govee_regal', 'li_govee_tisch', 'li_amaran_deko', 'li_virt_kette', 'li_virt_leiste'] },
];

const tr = (id, lightOrGroup, effect, offsetMs = 0, durationMs) => ({
  id,
  target: lightOrGroup.startsWith('grp_') ? { kind: 'group', groupId: lightOrGroup } : { kind: 'light', lightId: lightOrGroup },
  effect,
  offsetMs,
  ...(durationMs ? { durationMs } : {}),
});
const own = (effectId) => ({ type: 'own', effectId });
const native = (nativeId) => ({ type: 'native', nativeId });
const base = { enabled: true, after: 'restore', cooldownMs: 0, overlap: 'exclusive', triggerMode: 'inherit', tracks: [], tiers: [] };

const alerts = [
  {
    ...base, id: 'al_spenden', name: 'Spenden-Stufen', trigger: 'tip', mode: 'tiers',
    conditions: { amount: { mode: 'any' }, allowTest: true },
    tiers: [
      { id: 't1', label: 'Danke', amount: { mode: 'range', min: 1, max: 4.99 }, tracks: [tr('a1', 'li_virt_kette', own('fx_puls_violett'))] },
      { id: 't2', label: 'Glitzer', amount: { mode: 'range', min: 5, max: 9.99 }, tracks: [tr('a2', 'li_virt_kette', own('fx_lauflicht_cyan')), tr('a3', 'li_twinkly', native('movie:0'), 0, 5000)] },
      { id: 't3', label: 'Party', amount: { mode: 'range', min: 10, max: 49.99 }, tracks: [
        tr('a4', 'li_virt_kette', own('fx_farbwechsel')), tr('a5', 'li_virt_leiste', own('fx_lauflicht_cyan'), 300), tr('a6', 'li_govee_regal', native('scene:3'), 300, 6000),
      ] },
      { id: 't4', label: 'Mega', amount: { mode: 'min', min: 50 }, tracks: [
        tr('a7', 'li_virt_kette', own('fx_regenbogen')), tr('a8', 'li_virt_leiste', own('fx_fuellstand_betrag'), 500), tr('a9', 'li_amaran_deko', native('effect:1'), 0, 4000), tr('a10', 'grp_hintergrund', own('fx_regenbogen'), 1000),
      ] },
      { id: 't5', label: '13,37 € Easter Egg', amount: { mode: 'exact', value: 13.37 }, tracks: [tr('a11', 'li_virt_kette', own('fx_blitz_weiss'))] },
    ],
  },
  {
    ...base, id: 'al_bits', name: 'Bits-Glühen', trigger: 'cheer', mode: 'single',
    conditions: { amount: { mode: 'min', min: 100 }, allowTest: true },
    tracks: [tr('b1', 'li_virt_kette', own('fx_bits_glow')), tr('b2', 'li_govee_tisch', own('fx_bits_glow'), 200)],
  },
  {
    ...base, id: 'al_gift', name: 'Gift-Bombe', trigger: 'giftSub', mode: 'single', cooldownMs: 5000,
    conditions: { amount: { mode: 'min', min: 5 }, allowTest: true },
    tracks: [tr('g1', 'grp_alle_deko', own('fx_farbwechsel')), tr('g2', 'li_govee_regal', native('scene:0'), 0, 6000)],
  },
  {
    ...base, id: 'al_farbe', name: 'Farbe per Kanalpunkte', trigger: 'channelPoints', mode: 'single',
    conditions: { amount: { mode: 'any' }, reward: 'Farbe wählen', allowTest: true },
    tracks: [tr('c1', 'li_virt_kette', { type: 'eventColor', fallback: '#b794ff', brightness: 100 }, 0, 10000), tr('c2', 'li_govee_regal', { type: 'eventColor', fallback: '#b794ff', brightness: 100 }, 0, 10000)],
  },
  {
    ...base, id: 'al_raid', name: 'Raid-Willkommen', trigger: 'raid', mode: 'single', triggerMode: 'manual',
    conditions: { amount: { mode: 'min', min: 10 }, allowTest: true },
    tracks: [tr('r1', 'li_virt_kette', own('fx_raid_welle')), tr('r2', 'li_amaran_deko', native('effect:0'), 0, 5000)],
  },
  {
    ...base, id: 'al_chat', name: 'Chat: !party', trigger: 'chatMessage', mode: 'single', cooldownMs: 60000,
    conditions: { amount: { mode: 'any' }, textContains: '!party', allowTest: true },
    tracks: [tr('h1', 'li_ha_lampe', native('ha-effect:0'), 0, 8000)],
  },
];

const settings = {
  streamelements: { enabled: false, jwt: '', channelId: '', topics: { activities: true, tips: false, chat: true } },
  homeassistant: { enabled: false, url: 'http://192.168.178.30:8123', token: '' },
  amaran: { enabled: false, url: 'ws://192.168.178.20:33782/ws', clientId: 'uelights', intensityScale: 100, presetCommand: 'set_preset', sceneCommand: 'set_scene' },
  safety: { maxFlashHz: 3, staleEventSec: 30, queueMax: 10, paused: false, quietHours: { enabled: false, from: '23:00', to: '08:00' }, lockSceneLights: true },
  events: { giftBundleWindowMs: 15000, channelCurrency: 'EUR', fxRates: { USD: 0.92, GBP: 1.17, CHF: 1.06 }, foreignCurrency: 'convert' },
  triggerMode: 'auto',
  colorCommandRate: 5,
  realtimeFps: 25,
};

const now = Date.now();
const ago = (s) => new Date(now - s * 1000).toISOString();
const ev = (sec, type, user, amount, extra = {}) => ({
  id: `demo_${sec}_${type}`, source: 'streamelements', type, rawType: type, provider: 'twitch', user, amount, isTest: false, ts: ago(sec), ...extra,
});
const done = (alertIds, tierLabel) => ({ status: 'done', alertIds, ...(tierLabel ? { tierLabel } : {}) });
const log = [
  { event: ev(40, 'cheer', 'nachtfalke', 500, { message: 'Cheer500 GG!' }), outcome: done(['al_bits']), alertNames: ['Bits-Glühen'], receivedAt: ago(40) },
  { event: ev(95, 'channelPoints', 'pixelpilot', undefined, { reward: 'Farbe wählen', message: 'blau' }), outcome: done(['al_farbe']), alertNames: ['Farbe per Kanalpunkte'], receivedAt: ago(95) },
  { event: ev(160, 'giftSub', 'sternenstaub', 10), outcome: done(['al_gift']), alertNames: ['Gift-Bombe'], receivedAt: ago(160) },
  { event: ev(240, 'tip', 'zuschauer_42', 13.37, { currency: 'EUR', message: 'leet!' }), outcome: done(['al_spenden'], '13,37 € Easter Egg'), alertNames: ['Spenden-Stufen'], receivedAt: ago(240) },
  { event: ev(330, 'follow', 'neugierig99'), outcome: { status: 'skipped', reason: 'Kein passender Alert' }, alertNames: [], receivedAt: ago(330) },
  { event: ev(420, 'tip', 'mondkatze', 5, { currency: 'EUR', message: 'Schöner Stream!' }), outcome: done(['al_spenden'], 'Glitzer'), alertNames: ['Spenden-Stufen'], receivedAt: ago(420) },
  { event: ev(600, 'raid', 'frankenfreunde', 37), outcome: done(['al_raid']), alertNames: ['Raid-Willkommen'], receivedAt: ago(600) },
];

fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ version: 1, alerts, effects, lights, groups, settings, auth: {} }, null, 2));
fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log));
console.log(`Demo-Daten in ${dir}\nStart: DATA_DIR=${dir} UELIGHTS_DISABLE_AUTH=1 npm start`);
