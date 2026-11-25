import crypto from 'node:crypto';
import type { Store } from './store.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export class Auth {
  private sessions = new Map<string, number>();

  constructor(private store: Store, private envPassword: string, public disabled: boolean) {
    if (!store.data.auth.sessionSecret) {
      store.data.auth.sessionSecret = crypto.randomBytes(32).toString('hex');
      store.commit();
    }
  }

  /** Ist ein Passwort gesetzt (Umgebungsvariable oder Ersteinrichtung)? */
  get configured(): boolean {
    return this.disabled || !!this.envPassword || !!this.store.data.auth.passwordHash;
  }

  setPassword(pw: string): void {
    if (pw.length < 8) throw new Error('Das Passwort muss mindestens 8 Zeichen haben.');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pw, salt, 64);
    this.store.data.auth.passwordHash = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
    this.sessions.clear();
    this.store.commit();
  }

  verify(pw: string): boolean {
    if (this.envPassword) {
      const a = Buffer.from(pw);
      const b = Buffer.from(this.envPassword);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const stored = this.store.data.auth.passwordHash;
    if (!stored) return false;
    const [, saltHex, hashHex] = stored.split('$');
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  }

  createSession(): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  check(token: string | undefined): boolean {
    if (this.disabled) return true;
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
