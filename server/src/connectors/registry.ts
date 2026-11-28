import type { Light, Settings } from '@uelights/shared';
import { AmaranClient, AmaranDriver } from './amaran.js';
import { GoveeDriver, GoveeLan } from './govee.js';
import { HomeAssistantClient, HomeAssistantDriver } from './homeassistant.js';
import { HueClient, HueDriver } from './hue.js';
import { TwinklyDriver } from './twinkly.js';
import type { LightDriver } from './types.js';
import { VirtualDriver, WebhookDriver } from './virtual.js';

/** Hält je Licht einen Treiber und die gemeinsamen Verbindungen (Govee-UDP, amaran, Hue, Home Assistant). */
export class DriverRegistry {
  private drivers = new Map<string, { driver: LightDriver; key: string }>();
  readonly govee = new GoveeLan();
  readonly amaran: AmaranClient;
  readonly ha: HomeAssistantClient;
  readonly hue: HueClient;

  constructor(
    private getSettings: () => Settings,
    haToken: string,
    amaranKey: string,
    onStatus: () => void,
    private emitVirtual: (lightId: string, leds: string[]) => void,
  ) {
    this.amaran = new AmaranClient(() => getSettings().amaran, onStatus, amaranKey);
    this.ha = new HomeAssistantClient(() => getSettings().homeassistant, haToken, onStatus);
    this.hue = new HueClient(() => getSettings().hue, onStatus);
  }

  /** Treiber holen; bei geänderter Konfiguration neu anlegen. */
  get(light: Light): LightDriver {
    const key = JSON.stringify([light.connector, light.config, light.ledCount]);
    const hit = this.drivers.get(light.id);
    if (hit && hit.key === key) {
      // Name/Rolle/Effekte können sich ändern, ohne den Treiber neu zu bauen
      (hit.driver as { light: Light }).light = light;
      return hit.driver;
    }
    hit?.driver.dispose?.();
    const driver = this.create(light);
    this.drivers.set(light.id, { driver, key });
    return driver;
  }

  private create(light: Light): LightDriver {
    switch (light.connector) {
      case 'twinkly':
        return new TwinklyDriver(light);
      case 'govee':
        return new GoveeDriver(light, this.govee);
      case 'amaran':
        return new AmaranDriver(light, this.amaran, () => this.getSettings().amaran);
      case 'hue':
        return new HueDriver(light, this.hue, () => this.getSettings().colorCommandRate);
      case 'homeassistant':
        return new HomeAssistantDriver(light, this.ha);
      case 'webhook':
        return new WebhookDriver(light);
      case 'virtual':
      default:
        return new VirtualDriver(light, this.emitVirtual);
    }
  }

  remove(lightId: string): void {
    this.drivers.get(lightId)?.driver.dispose?.();
    this.drivers.delete(lightId);
  }

  stopAll(): void {
    for (const { driver } of this.drivers.values()) driver.dispose?.();
    this.govee.stop();
    this.amaran.stop();
    this.ha.stop();
    this.hue.stop();
  }
}
