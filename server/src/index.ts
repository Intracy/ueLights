import { buildApp } from './app.js';
import { config } from './config.js';

// Ein einzelner Fehler (z. B. eine unerwartete Nachricht eines Geräts) darf den Server nicht beenden
process.on('uncaughtException', (err) => console.error('Unerwarteter Fehler (ueLights läuft weiter):', err));
process.on('unhandledRejection', (err) => console.error('Unbehandelter Fehler (ueLights läuft weiter):', err));

const app = await buildApp();

const shutdown = async () => {
  setTimeout(() => process.exit(0), 3000).unref();
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`ueLights läuft auf http://${config.host}:${config.port}`);
