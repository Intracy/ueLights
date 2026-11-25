#!/usr/bin/env node
// Baut eine eigenständige ausführbare Datei (Node Single Executable Application):
// Server + Web-App + Node-Laufzeit in einer Datei. Unter Windows entsteht release/ueLights.exe.
// Voraussetzung: `npm run build` wurde ausgeführt (web/dist existiert).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const work = path.join(out, 'sea');
const webDist = path.join(root, 'web', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';
const exeName = isWin ? 'ueLights.exe' : 'uelights';

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('web/dist fehlt – zuerst `npm run build` ausführen.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// 1) Server inkl. aller Abhängigkeiten zu einer CommonJS-Datei bündeln
const entry = path.join(work, 'uelights.cjs');
await build({
  entryPoints: [path.join(root, 'server', 'src', 'sea-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: entry,
  alias: { '@uelights/shared': path.join(root, 'packages', 'shared', 'src', 'index.ts') },
  define: { __UELIGHTS_VERSION__: JSON.stringify(pkg.version) },
  external: ['node:sea'],
  logLevel: 'warning',
});

// 2) Web-App als Assets einbetten
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(webDist, p).split(path.sep).join('/'));
  }
})(webDist);
fs.writeFileSync(path.join(work, 'web-manifest.json'), JSON.stringify(files));
const assets = { 'web-manifest.json': path.join(work, 'web-manifest.json') };
for (const f of files) assets[`web/${f}`] = path.join(webDist, f);

const seaConfig = {
  main: entry,
  output: path.join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' });

// 3) Node-Binary kopieren und Blob einspritzen
const exe = path.join(out, exeName);
fs.copyFileSync(process.execPath, exe);
if (isWin) {
  // Icon und Versionsinfo setzen (vor dem Einspritzen)
  try {
    const mod = await import('rcedit');
    const rcedit = mod.rcedit ?? mod.default?.rcedit ?? mod.default;
    await rcedit(exe, {
      icon: path.join(root, 'docs', 'icon.ico'),
      'file-version': pkg.version,
      'product-version': pkg.version,
      'version-string': { ProductName: 'ueLights', FileDescription: 'ueLights – StreamElements-Alerts auf lokale Lichter', CompanyName: 'Tobias Lindner', LegalCopyright: 'MIT' },
    });
  } catch (err) {
    console.warn('Icon/Versionsinfo nicht gesetzt:', err.message);
  }
  // vorhandene Signatur entfernen, falls signtool verfügbar (optional)
  try {
    execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
  } catch {
    /* ohne signtool geht es auch */
  }
}
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
if (!isWin) fs.chmodSync(exe, 0o755);

fs.rmSync(work, { recursive: true, force: true });
const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\n✔ ${path.relative(root, exe)} (${mb} MB, ${files.length} Web-Dateien eingebettet)`);
