import path from 'node:path';

/** Laufzeit-Konfiguration aus Umgebungsvariablen. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  /** Optional: Passwort fest vorgeben (sonst beim ersten Start im Browser setzen) */
  password: process.env.UELIGHTS_PASSWORD ?? '',
  /** Optional: StreamElements-JWT per Umgebungsvariable statt in den Einstellungen */
  seJwt: process.env.SE_JWT ?? '',
  /** Optional: Home-Assistant-Token per Umgebungsvariable */
  haToken: process.env.HA_TOKEN ?? '',
  amaranKey: process.env.AMARAN_API_KEY ?? '',
  /** Pfad zum gebauten Web-Frontend */
  webDir: path.resolve(process.env.WEB_DIR ?? './web/dist'),
  /** Login abschalten (nur für Tests / reines Heimnetz ohne Freigabe) */
  disableAuth: process.env.UELIGHTS_DISABLE_AUTH === '1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
