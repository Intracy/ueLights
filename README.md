# ueLights

**StreamElements-Alerts → Lichtshow – komplett lokal.**
ueLights empfängt Spenden, Bits, Subs, Raids, Kanalpunkte und Chat-Befehle von StreamElements und steuert damit Twinkly-, Govee- und amaran-Lichter sowie alles, was in Home Assistant hängt. Einzige Verbindung nach außen ist der WebSocket zu StreamElements; alle Lichter werden über das lokale Netz angesprochen.

![Stack](https://img.shields.io/badge/stack-Node%2022%20%C2%B7%20Fastify%20%C2%B7%20React%20%C2%B7%20Vite-7c4dff) ![Design](https://img.shields.io/badge/design-Material%203%20%C2%B7%20Schwarz--Violett-3de0e8)

---

## Funktionen

| Bereich | Was geht |
| --- | --- |
| **Auslösung** | **Automatisch** (Standard): eingehende StreamElements-Alerts lösen die Lichter sofort aus. **Manuell**: passende Alerts warten im Live-Feed auf *Freigeben* / *Verwerfen*. Umschalter oben rechts; jeder Alert kann die globale Einstellung übersteuern |
| **Trigger** | Alle StreamElements-Aktivitäten: Spende (Tip), Bits, Sub/Resub, Gift-Subs (Gift-Bomben gebündelt), Raid, Follow, Kanalpunkte, Chat-Nachrichten/-Befehle, Superchat, Merch, Hype-Train |
| **Bedingungen** | Betrag *genau / von–bis / ab*, Stufen nach Betrag (5 € → Alert A, 10 € → Alert B …), Text in der Nachricht, Kanalpunkte-Belohnung, Plattform, Sub-Stufe, Testevents ja/nein |
| **Alert-Builder** | Beliebig viele Alerts; je Alert/Stufe beliebig viele **Licht-Spuren** (Licht oder Gruppe + Effekt + Startversatz + Dauer) mit Zeitleiste |
| **Effekte** | Eigene Effekte (Statisch, Puls, Strobe, Farbwechsel, Regenbogen, Lauflicht, Füllstand, Überblenden) mit Live-Vorschau; **Hersteller-Effekte** aus den Apps (Twinkly-Movies/Playlists, Govee-Szenen, amaran-Effekte/Presets/Szenen, Home-Assistant-Effekte/-Szenen/-Skripte) |
| **Betrag als Parameter** | Helligkeit, Füllstand oder Dauer wachsen mit der Spende/den Bits |
| **Farbe aus dem Chat** | „Farbe aus Nachricht“: Kanalpunkte „Farbe wählen: blau“ oder `!farbe #ff00ff` färbt die Lichter (Farbwort-Liste + Hex) |
| **Lichter** | Twinkly (xled, Echtzeit pro LED), Govee (LAN-API + Szenen per ptReal), amaran (amaran Desktop), Home Assistant, Webhook, **virtuelle Lichter** zum Testen ohne Hardware |
| **Gruppen** | Lichter verschiedener Hersteller zusammenfassen |
| **Ruhezustand** | Je Licht: wie vorher (Snapshot), aus, feste Farbe oder Hersteller-Effekt |
| **Sicherheit** | Flacker-Schutz (max. Blitze/s, Standard 3), Bildlicht-Sperre, Ruhezeiten, Pause, **Alles stoppen**, alte Events nach Reconnect verwerfen, Warteschlangen-Limit, Login |
| **Live** | Live-Feed mit Status, „läuft gerade“ mit Fortschritt, Warteschlange, erneut abspielen, Testevents, Vorschau virtueller Lichter |
| **Sonstiges** | Backup/Import als JSON (ohne Geheimnisse), PWA fürs iPad/iPhone, Dark-Theme nach Material 3 |

## Architektur

```
StreamElements Astro (wss, ausgehend)
        │  channel.activities · channel.chat.message · (channel.tips)
        ▼
┌──────────────── ueLights-Server (Docker auf dem NAS) ────────────────┐
│ Normalisieren → Duplikate/Gift-Bomben → Alert-Engine → Warteschlange │
│                     (Stufen, Priorität, Cooldown)    → Player        │
│                                                        │             │
│   Twinkly  ·  Govee LAN  ·  amaran Desktop  ·  Home Assistant  ·  Webhook  ·  virtuell
└────────────────────────────────────────────────────────┬─────────────┘
                                                         │ REST + WebSocket
                                              Web-App (Browser / PWA)
```

* `packages/shared` – Typen, Effekt-Renderer, Stufen-Logik (läuft im Server **und** im Browser für die Vorschau)
* `server` – Fastify, StreamElements-Client, Engine, Konnektoren, JSON-Datenhaltung
* `web` – React + Vite, Material 3 Schwarz-Violett

## Schnellstart (Synology NAS / Docker)

```bash
git clone https://github.com/Intracy/ueLights.git
cd ueLights
docker compose up -d --build
```

Dann `http://<NAS-IP>:8787` öffnen, Passwort festlegen, fertig. Von unterwegs z. B. per Tailscale.

> **Warum `network_mode: host`?** Die Gerätesuche von Twinkly (UDP-Broadcast) und Govee (Multicast 239.255.255.250:4001, Antworten auf Port 4002) funktioniert nur im Host-Netz. Wer feste IPs einträgt und Govee nicht nutzt, kann auch mit Port-Freigabe `8787:8787` arbeiten.

Synology DSM: *Container Manager → Projekt → Erstellen*, Ordner mit dem Repo wählen, `docker-compose.yml` übernehmen.

### Windows (ohne Docker)

Gut geeignet, wenn amaran Desktop auf demselben PC läuft – dann reicht `ws://localhost:33782/ws`.

1. Repo als ZIP laden (GitHub → *Code → Download ZIP*) und entpacken – oder `git clone`.
2. **`ueLights-starten.bat`** doppelklicken.
   * Fehlt Node.js 20+, bietet das Skript die Installation per `winget` an.
   * Beim ersten Start werden Abhängigkeiten installiert und die App gebaut (einige Minuten), danach startet sie in Sekunden. Nach Code-Änderungen baut das Skript automatisch neu.
   * Der Browser öffnet `http://localhost:8787`. Beenden mit Strg+C.
3. Windows fragt beim ersten Start nach der Firewall: **Private Netzwerke zulassen** (für Zugriff vom Handy und für Govee).

| Skript | Zweck |
| --- | --- |
| `ueLights-starten.bat` | Starten im Fenster (Optionen: `-Port 8788`, `-Rebuild`, `-NoBrowser`) |
| `windows\autostart-einrichten.ps1` | Start bei jeder Windows-Anmeldung, unsichtbar, mit Neustart bei Absturz. `-Firewall` (als Admin) legt Regeln für TCP 8787 und UDP 4002 an |
| `windows\autostart-entfernen.ps1` | Autostart entfernen und Hintergrund-Server beenden |
| `windows\update.ps1` | `git pull`, neu bauen, Autostart neu starten |

PowerShell-Skripte per Rechtsklick → *Mit PowerShell ausführen*. Daten liegen in `%LOCALAPPDATA%\ueLights`, Logs des Hintergrundbetriebs in `%LOCALAPPDATA%\ueLights\logs\uelights.log`.

### Ohne Docker (Linux/macOS)

```bash
npm install
npm run build
npm start                 # http://localhost:8787
```

Entwicklung: `npm run dev` (Server auf 8787 mit Auto-Reload, Vite auf 5173 mit Proxy).

## Einrichtung

### 1. StreamElements
1. StreamElements-Dashboard → Avatar oben rechts → Kanal → **Show secrets** → **JWT Token** kopieren.
2. In ueLights → *Einstellungen → StreamElements* einfügen, „Verbindung aktiv“ einschalten, speichern.
3. Die Kanal-ID wird aus dem Token gelesen. Status oben rechts wird grün.

Der Token liegt nur in `data/store.json` auf dem NAS (Dateirechte 600) und wird nie an den Browser zurückgegeben. Alternativ per Umgebungsvariable `SE_JWT`.

**Testen:** Auf der Live-Seite Testevents auslösen – oder im StreamElements-Dashboard unter *Activity Feed → Emulate*. Damit Alerts auf Testevents reagieren, muss „Testevents zulassen“ im Alert aktiv sein.

### 2. Lichter

#### Twinkly (Strings HD u. a.)
* Kette in der Twinkly-App ins WLAN bringen, IP im Router fest reservieren.
* *Lichter → Licht hinzufügen → Twinkly* → **Suchen** oder IP eintragen → **Prüfen** zeigt Modell, LED-Anzahl, RGB/RGBW.
* **Hersteller-Effekte:** In der Twinkly-App die gewünschten Effekte in die **Playlist** der Kette legen – nur dann liegen sie auf dem Controller. Danach *Effekte → Hersteller → Neu einlesen*.
* Eigene Effekte laufen in Echtzeit pro LED (UDP 7777). Sind die Farben vertauscht, unter „Farbkanäle“ eine andere Reihenfolge wählen (die Strings HD sind RGBW – ob `WRGB` oder `RGBW` passt, zeigt der erste Test).
* Hinweis: Die xled-API ist **inoffiziell** (Reverse Engineering). Twinkly-Firmware-Updates können sie ändern.

Schnelltest ohne ueLights: `curl http://<IP>/xled/v1/gestalt` muss JSON liefern.

#### Govee
* In der Govee-Home-App je Gerät **LAN Control** einschalten (nur Modelle von Govees LAN-Liste).
* Im Netz müssen UDP 4001 (Multicast), 4002 (Antwort) und 4003 (Befehle) durchgehen. Port **4002** darf auf dem Host nicht belegt sein – also nicht parallel Home Assistant „Govee lights local“ auf demselben Rechner betreiben.
* Lokal (offiziell): an/aus, Helligkeit, Farbe. Eigene Effekte laufen als gedrosselte Farbfolge (Standard 5 Befehle/s).
* **App-Szenen lokal (inoffiziell):** Govee-Geräte können ihre Szenen nicht auflisten. Den Szenen-Katalog deines Modells einmal als JSON besorgen und unter *Effekte → Hersteller → Szenen importieren* einfügen. Ausgelöst wird lokal per `ptReal` (dasselbe Protokoll wie die App). Unterstützte Formate:

```jsonc
// 1) einfache Liste
[{ "name": "Aurora", "sceneCode": 1234, "sceneParam": "<base64 optional>" }]
// 2) Govee-Bibliotheksformat
{ "data": { "categories": [{ "scenes": [{ "sceneName": "Wald", "lightEffects": [{ "sceneCode": 99, "scenceParam": "AQI=" }] }] }] } }
// 3) mitgeschnittene Befehle
[{ "name": "DIY Blitz", "commands": ["<Base64, 20 Byte>", "…"] }]
```

  Szenen ohne Parameter sind zuverlässig; Szenen mit Parameter-Block sind nach der Kodierung von govee2mqtt/govee-local-api umgesetzt und sollten pro Modell kurz getestet werden. „Snapshots“ aus der Govee-App liegen nur in Govees Cloud und sind lokal nicht erreichbar.

#### amaran / Aputure
* **amaran Desktop** (Mac/Windows) muss laufen; sie hält die Bluetooth-Verbindung zu den Leuchten und öffnet einen lokalen WebSocket (Standard-Port **33782**).
* *Einstellungen → amaran Desktop*: Adresse `ws://<Rechner-IP>:33782/ws`, aktivieren. Lauscht die App nur auf `localhost`, ueLights auf demselben Rechner betreiben oder einen kleinen Port-Weiterleiter einrichten.
* *Lichter → amaran → Suchen* listet die Leuchten (Node-ID).
* Hersteller-Effekte: eingebaute Effekte, Presets und Szenen werden eingelesen. Die Befehlsnamen für Presets/Szenen (`set_preset`, `set_scene`) und die Intensitäts-Skala sind unter *Erweitert* einstellbar, falls deine App-Version andere erwartet.
* Ein Gerät verarbeitet höchstens alle 200 ms einen Befehl – ueLights drosselt entsprechend.
* Studio-Leuchten im Bild als **Bildlicht** markieren – dann schalten Alerts sie nie.

#### Home Assistant
* Home Assistant → Profil → Sicherheit → **Langlebiges Zugriffstoken** erstellen.
* *Einstellungen → Home Assistant*: Adresse (`http://<IP>:8123`) und Token eintragen, aktivieren.
* *Lichter → Home Assistant → Suchen* listet `light.*`, `scene.*` und `script.*`. Die `effect_list` der Lichter erscheint als Hersteller-Effekte – z. B. alle Govee-App-Szenen mit der HACS-Integration *Govee Local Plus*, Twinkly-Effekte über die offizielle Integration.
* Ein Licht entweder direkt oder über Home Assistant anlegen, nicht beides.

#### Virtuell & Webhook
* **Virtuell:** LED-Streifen auf der Live-Seite – ideal, um Alerts ohne Hardware zu bauen.
* **Webhook:** `POST` mit JSON (`type: alert|color|restore|off`, Event-Daten) an eine lokale Adresse, z. B. Node-RED.

### 3. Alerts bauen
1. *Alerts → Neuer Alert*, Trigger wählen (z. B. „Spende (Tip)“).
2. **Ein Alert** oder **Stufen nach Betrag**. Bei Stufen z. B. `1–4,99 €`, `5–9,99 €`, `10–49,99 €`, `ab 50 €`. Ein exakter Betrag (`genau 4,20 €`) gewinnt immer gegen einen Bereich. Lücken/Überschneidungen werden angezeigt.
3. Je Stufe **Licht hinzufügen** → Licht/Gruppe, Effekt (eigen, Hersteller oder „Farbe aus Nachricht“), Start und Dauer.
4. **Testen** spielt die gewählte Stufe sofort ab.

Passen mehrere Alerts auf ein Event, gewinnt der spezifischste (exakt > Bereich > ab > jeder Betrag), bei Gleichstand der weiter oben in der Liste. Alerts mit „Immer zusätzlich ausführen“ laufen parallel mit. Alerts laufen nacheinander über eine Warteschlange.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8787` | Port der Web-App |
| `DATA_DIR` | `./data` (`/data` im Container) | Einstellungen, Alerts, Protokoll |
| `UELIGHTS_PASSWORD` | – | Passwort fest vorgeben |
| `SE_JWT` | – | StreamElements-Token |
| `HA_TOKEN` | – | Home-Assistant-Token |
| `UELIGHTS_DISABLE_AUTH` | `0` | Login abschalten (nur Tests) |
| `LOG_LEVEL` | `info` | `debug` zeigt mehr |

## API (Auszug)

Alle Endpunkte unter `/api`, Anmeldung per Session-Cookie.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Alles für die Web-App |
| `POST/PUT/DELETE` | `/api/alerts`, `/api/effects`, `/api/lights`, `/api/groups` | Verwalten; `PUT /api/alerts` mit Liste = Reihenfolge |
| `POST` | `/api/alerts/:id/fire` | Alert/Stufe testen (`{ tierId, amount }`) |
| `POST` | `/api/test-event` | Testevent (`{ type, amount, message, reward }`) |
| `POST` | `/api/stop` · `/api/pause` | Alles stoppen · Pause |
| `POST` | `/api/trigger-mode` | `{ mode: "auto" \| "manual" }` |
| `POST` | `/api/events/:id/release` · `/dismiss` · `/api/pending/release-all` | Manuellen Alert freigeben / verwerfen |
| `POST` | `/api/lights/:id/natives/refresh` · `/import` | Hersteller-Effekte einlesen/importieren |
| `GET` | `/api/discover/{twinkly,govee,homeassistant,amaran}` | Geräte finden |
| `GET/POST` | `/api/export` · `/api/import` | Sicherung |
| `WS` | `/api/live` | Live-Events, Status, virtuelle LEDs |

Ein Stream-Deck/Companion kann Alerts per `POST /api/alerts/:id/fire` auslösen (mit Cookie oder bei `UELIGHTS_DISABLE_AUTH=1` im abgeschotteten Netz).

## Bekannte Grenzen / beim ersten Live-Test prüfen

* **StreamElements-Felder:** Die Payloads sind je Plattform leicht unterschiedlich; ueLights liest sie defensiv. Das Rohformat jedes Events steht im Protokoll (`data/events.json`), falls ein Feld fehlt.
* **Twinkly Strings HD** ist in der xled-Doku nicht getestet – Hardware-Test (Prüfen, Effekt testen, Farbkanäle) zuerst.
* **amaran:** Preset-/Szenen-Befehlsnamen und Intensitäts-Skala sind konfigurierbar, weil die OpenAPI-Doku nicht öffentlich lesbar ist.
* **Govee-Szenen mit Parametern** sind inoffiziell; Snapshots aus der Cloud gehen lokal nicht.
* Sitzungen liegen im Speicher – nach einem Neustart einmal neu anmelden.

## Roadmap (noch nicht umgesetzt)

* **Stream Deck / Companion ohne Login:** API-Schlüssel statt Session-Cookie für `POST /api/alerts/:id/fire`
* **Weitere Trigger-Quellen:** OBS-Szenenwechsel (obs-websocket), eingehende Webhooks (z. B. FF-Overlay, betterplace)
* **MQTT-Konnektor**
* **Twinkly-Layout:** räumliche Effekte (Welle am Baum) aus dem in der App gemappten Layout
* **Ziele / Hype-Train** als dauerhafte Füllstandsanzeige (`channel.session.update`)
* **Zeitleiste per Drag & Drop**, Alerts per Drag & Drop sortieren
* **Undo / Versionen** für Alerts und Effekte, Statistik (welcher Alert wie oft, Fehlerquote je Gerät)
* **Warteschlange je Gerät** statt einer globalen (Alerts auf verschiedenen Lichtern parallel)
* Spenden-Moderation (`channel.tips.moderation`), Sessions über Neustarts hinweg
* Windows-`.exe` (Node Single Executable) per GitHub Actions

## Entwicklung

```bash
npm install
npm test          # Vitest: Stufen, Effekte, Flacker-Schutz, Normalisierung, Gift-Bündelung, Govee-Kodierung
npm run typecheck
npm run dev
```

## Lizenz

MIT
