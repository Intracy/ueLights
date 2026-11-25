/**
 * Einstieg für die eigenständige ueLights.exe (Node Single Executable Application).
 * – entpackt die eingebettete Web-App beim ersten Start
 * – legt Daten unter %LOCALAPPDATA%\ueLights ab
 * – öffnet den Browser; läuft ueLights schon, wird nur der Browser geöffnet
 */
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

declare const __UELIGHTS_VERSION__: string;

function appBaseDir(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ueLights');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ueLights');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'uelights');
}

function openBrowser(url: string): void {
  if (process.env.UELIGHTS_NO_BROWSER === '1') return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
    sock.setTimeout(500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** Eingebettete Web-Dateien (SEA-Assets) in einen versionierten Ordner schreiben. */
async function extractWeb(base: string): Promise<string | null> {
  let sea: { isSea: () => boolean; getAsset: (k: string) => ArrayBuffer };
  try {
    sea = await import('node:sea');
  } catch {
    return null;
  }
  if (!sea.isSea()) return null;
  const manifest = JSON.parse(Buffer.from(sea.getAsset('web-manifest.json')).toString('utf8')) as string[];
  const hash = crypto.createHash('sha1').update(manifest.join('|') + __UELIGHTS_VERSION__).digest('hex').slice(0, 10);
  const dir = path.join(base, 'web', hash);
  const marker = path.join(dir, '.complete');
  if (!fs.existsSync(marker)) {
    fs.rmSync(path.join(base, 'web'), { recursive: true, force: true });
    for (const rel of manifest) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(sea.getAsset(`web/${rel}`)));
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }
  return dir;
}

async function main(): Promise<void> {
  const base = appBaseDir();
  fs.mkdirSync(base, { recursive: true });
  const port = Number(process.env.PORT ?? 8787);
  const url = `http://localhost:${port}`;

  console.log('');
  console.log(`  ueLights ${__UELIGHTS_VERSION__}`);
  console.log('  StreamElements-Alerts → Lichter, komplett lokal');
  console.log('');

  if (await portInUse(port)) {
    console.log(`  ueLights läuft bereits auf ${url} – öffne den Browser.`);
    openBrowser(url);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  const webDir = await extractWeb(base);
  process.env.DATA_DIR ??= path.join(base, 'data');
  if (webDir) process.env.WEB_DIR ??= webDir;
  process.env.NODE_ENV ??= 'production';
  process.env.LOG_LEVEL ??= 'warn';

  // Erst jetzt laden, damit die Konfiguration die Umgebungsvariablen sieht
  const { buildApp } = await import('./app.js');
  const { config } = await import('./config.js');
  const app = await buildApp();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // IPv4 und IPv6 (Windows löst "localhost" zuerst als ::1 auf); ohne IPv6 auf IPv4 zurückfallen
  try {
    await app.listen({ port: config.port, host: process.env.HOST ?? '::' });
  } catch (err) {
    if (process.env.HOST) throw err;
    await app.listen({ port: config.port, host: '0.0.0.0' });
  }

  console.log(`  Web-App:     ${url}`);
  console.log(`  Im Heimnetz: http://<IP dieses PCs>:${port}`);
  console.log(`  Daten:       ${config.dataDir}`);
  console.log('  Beenden:     Fenster schließen oder Strg+C');
  console.log('');
  openBrowser(url);
}

main().catch((err) => {
  console.error('ueLights konnte nicht starten:', err);
  if (process.platform === 'win32') {
    console.error('\nFenster schließt in 30 Sekunden …');
    setTimeout(() => process.exit(1), 30_000);
  } else process.exit(1);
});
