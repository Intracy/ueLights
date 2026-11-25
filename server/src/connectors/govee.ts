import dgram from 'node:dgram';
import type { Light, NativeEffect, Rgb } from '@uelights/shared';
import { DriverError, type DriverCapabilities, type LightDriver } from './types.js';

const MULTICAST = '239.255.255.250';
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const CMD_PORT = 4003;

// ------------------------- ptReal-Kodierung (Szenen) -------------------------

function withChecksum(bytes: number[]): Buffer {
  const b = bytes.slice(0, 19);
  while (b.length < 19) b.push(0);
  let x = 0;
  for (const v of b) x ^= v;
  return Buffer.from([...b, x]);
}

/**
 * Kodiert eine Szene der Govee-App als ptReal-Pakete (20 Byte, Base64), wie es die App im LAN tut.
 * Parameter-Blöcke: a3 00 01 <Anzahl> 02 <Daten…>, dann a3 <Index> …, letzter Index ff.
 * Abschluss: 33 05 04 <Code low> <Code high>.
 * Quelle der Kodierung: govee2mqtt / govee-local-api (inoffiziell).
 */
export function encodeScene(sceneCode: number, sceneParamB64?: string): string[] {
  const packets: Buffer[] = [];
  const param = sceneParamB64 ? Buffer.from(sceneParamB64, 'base64') : Buffer.alloc(0);
  if (param.length > 0) {
    const payloadPerFrame = 17;
    const total = Math.ceil((param.length + 3) / payloadPerFrame);
    const stream = [0x01, total, 0x02, ...param];
    for (let i = 0; i < total; i++) {
      const idx = i === total - 1 ? 0xff : i;
      const chunk = stream.slice(i * payloadPerFrame, (i + 1) * payloadPerFrame);
      packets.push(withChecksum([0xa3, idx, ...chunk]));
    }
  }
  packets.push(withChecksum([0x33, 0x05, 0x04, sceneCode & 0xff, (sceneCode >> 8) & 0xff]));
  return packets.map((p) => p.toString('base64'));
}

// ------------------------- gemeinsame UDP-Verbindung -------------------------

type Pending = { resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout };

/** Eine UDP-Verbindung für alle Govee-Geräte (Port 4002 muss frei sein). */
export class GoveeLan {
  private sock: dgram.Socket | null = null;
  private statusWaiters = new Map<string, Pending[]>();
  private scanResults = new Map<string, { ip: string; sku: string; device: string }>();
  error: string | null = null;

  start(): void {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      this.error = `UDP-Port ${LISTEN_PORT}: ${err.message}`;
    });
    sock.on('message', (buf, rinfo) => {
      let msg: { msg?: { cmd?: string; data?: Record<string, unknown> } };
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      const cmd = msg.msg?.cmd;
      const data = msg.msg?.data ?? {};
      if (cmd === 'scan') {
        const ip = String(data.ip ?? rinfo.address);
        this.scanResults.set(ip, { ip, sku: String(data.sku ?? ''), device: String(data.device ?? '') });
      } else if (cmd === 'devStatus') {
        const list = this.statusWaiters.get(rinfo.address);
        const w = list?.shift();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(data);
        }
      }
    });
    sock.bind(LISTEN_PORT, () => {
      try {
        sock.addMembership(MULTICAST);
      } catch {
        /* nicht kritisch */
      }
      this.error = null;
    });
    this.sock = sock;
  }

  send(ip: string, cmd: string, data: Record<string, unknown>): void {
    this.start();
    const payload = Buffer.from(JSON.stringify({ msg: { cmd, data } }));
    this.sock!.send(payload, CMD_PORT, ip);
  }

  status(ip: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.statusWaiters.get(ip) ?? [];
        this.statusWaiters.set(ip, list.filter((p) => p.timer !== timer));
        reject(new DriverError(`Govee ${ip} antwortet nicht (LAN Control aktiv?)`));
      }, timeoutMs);
      const list = this.statusWaiters.get(ip) ?? [];
      list.push({ resolve, timer });
      this.statusWaiters.set(ip, list);
      this.send(ip, 'devStatus', {});
    });
  }

  async scan(timeoutMs = 2000): Promise<Array<{ ip: string; sku: string; device: string }>> {
    this.start();
    this.scanResults.clear();
    const payload = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
    this.sock!.send(payload, SCAN_PORT, MULTICAST);
    await new Promise((r) => setTimeout(r, timeoutMs));
    return [...this.scanResults.values()];
  }

  stop(): void {
    this.sock?.close();
    this.sock = null;
  }
}

interface GoveeSnapshot {
  onOff: number;
  brightness: number;
  color?: { r: number; g: number; b: number };
  colorTemInKelvin?: number;
}

/**
 * Govee über die lokale LAN-API (UDP). Offiziell: an/aus, Helligkeit, Farbe.
 * Inoffiziell: Szenen der Govee-App per ptReal.
 */
export class GoveeDriver implements LightDriver {
  readonly capabilities: DriverCapabilities = { realtime: false, color: true, native: true };
  private isOn: boolean | null = null;
  private lastBrightness = -1;

  constructor(readonly light: Light, private lan: GoveeLan) {}

  private get ip(): string {
    const ip = this.light.config.ip;
    if (!ip) throw new DriverError('Keine IP-Adresse für Govee hinterlegt');
    return ip;
  }

  ledCount(): number {
    return 1;
  }

  async probe() {
    try {
      const s = await this.lan.status(this.ip);
      return { ok: true, detail: `${this.light.config.sku ?? 'Govee'} · ${s.onOff ? 'an' : 'aus'} · ${s.brightness ?? '?'} %` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async snapshot(): Promise<GoveeSnapshot> {
    const s = await this.lan.status(this.ip);
    return {
      onOff: Number(s.onOff ?? 1),
      brightness: Number(s.brightness ?? 100),
      color: s.color as GoveeSnapshot['color'],
      colorTemInKelvin: Number(s.colorTemInKelvin ?? 0),
    };
  }

  async restore(raw: unknown): Promise<void> {
    const s = raw as GoveeSnapshot;
    if (!s) return;
    if (!s.onOff) return this.off();
    this.lan.send(this.ip, 'turn', { value: 1 });
    this.lan.send(this.ip, 'brightness', { value: s.brightness });
    if (s.colorTemInKelvin && s.colorTemInKelvin > 0) {
      this.lan.send(this.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: s.colorTemInKelvin });
    } else if (s.color) {
      this.lan.send(this.ip, 'colorwc', { color: s.color, colorTemInKelvin: 0 });
    }
    this.isOn = true;
    this.lastBrightness = s.brightness;
  }

  async setColor(c: Rgb, brightness: number): Promise<void> {
    const b = Math.max(0, Math.min(100, Math.round(brightness)));
    if (b <= 0) {
      // Govee kennt 0 % nicht sauber – sehr dunkel statt aus, damit es nicht flackert
      if (this.lastBrightness !== 1) this.lan.send(this.ip, 'brightness', { value: 1 });
      this.lastBrightness = 1;
      return;
    }
    if (this.isOn !== true) {
      this.lan.send(this.ip, 'turn', { value: 1 });
      this.isOn = true;
    }
    if (b !== this.lastBrightness) {
      this.lan.send(this.ip, 'brightness', { value: b });
      this.lastBrightness = b;
    }
    this.lan.send(this.ip, 'colorwc', {
      color: { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) },
      colorTemInKelvin: 0,
    });
  }

  async listNative(): Promise<NativeEffect[]> {
    // Szenen kommen per Import (Katalog-JSON) – das Gerät selbst kann sie nicht auflisten.
    return this.light.nativeEffects;
  }

  async playNative(n: NativeEffect): Promise<void> {
    let commands: string[] = [];
    if (n.kind === 'scene') {
      commands = encodeScene(Number(n.data?.sceneCode), n.data?.sceneParam as string | undefined);
    } else if (n.kind === 'ptReal') {
      commands = (n.data?.commands as string[]) ?? [];
    }
    if (!commands.length) throw new DriverError(`Szene „${n.name}“ hat keine Befehle`);
    if (this.isOn !== true) {
      this.lan.send(this.ip, 'turn', { value: 1 });
      this.isOn = true;
    }
    this.lan.send(this.ip, 'ptReal', { command: commands });
  }

  async off(): Promise<void> {
    this.lan.send(this.ip, 'turn', { value: 0 });
    this.isOn = false;
  }
}

/**
 * Szenen-Katalog importieren. Akzeptiert:
 * – [{ name, sceneCode, sceneParam? }]
 * – Govee-Bibliotheksformat { data: { categories: [{ scenes: [{ sceneName, lightEffects: [{ sceneCode, scenceParam }] }] }] } }
 * – [{ name, commands: [base64…] }] für mitgeschnittene ptReal-Befehle
 */
export function parseSceneCatalog(input: unknown): NativeEffect[] {
  const out: NativeEffect[] = [];
  const push = (name: string, code: unknown, param?: unknown) => {
    const c = Number(code);
    if (!Number.isFinite(c) || c <= 0) return;
    out.push({
      id: `scene:${c}:${out.length}`,
      name,
      kind: 'scene',
      data: { sceneCode: c, sceneParam: typeof param === 'string' && param ? param : undefined },
    });
  };
  const root = input as Record<string, unknown>;
  if (Array.isArray(input)) {
    for (const it of input as Array<Record<string, unknown>>) {
      if (Array.isArray(it.commands)) {
        out.push({ id: `ptreal:${out.length}`, name: String(it.name ?? 'Befehl'), kind: 'ptReal', data: { commands: it.commands } });
      } else {
        push(String(it.name ?? it.sceneName ?? 'Szene'), it.sceneCode ?? it.code, it.sceneParam ?? it.scenceParam ?? it.param);
      }
    }
    return out;
  }
  const cats = ((root?.data as Record<string, unknown>)?.categories as Array<Record<string, unknown>>) ?? [];
  for (const cat of cats) {
    for (const sc of (cat.scenes as Array<Record<string, unknown>>) ?? []) {
      const effects = (sc.lightEffects as Array<Record<string, unknown>>) ?? [];
      const name = String(sc.sceneName ?? 'Szene');
      if (effects.length === 0) push(name, sc.sceneCode);
      effects.forEach((e, i) => push(effects.length > 1 ? `${name} ${i + 1}` : name, e.sceneCode, e.scenceParam ?? e.sceneParam));
    }
  }
  return out;
}
