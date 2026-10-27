# ScanDeals KI-Server (Cloudflare Worker)

Dieser kleine Server erkennt Produkte auf Fotos. Die ScanDeals-App schickt dafür einen Bildausschnitt an den Worker, der Worker fragt Claude (Anthropic) und liefert Name, Marke, Modell und eine Suchanfrage zurück. Dein API-Schlüssel liegt nur im Worker und nie in der App.

**Die App funktioniert auch ohne diesen Server** (Gratis-Modus mit allgemeinen Kategorien wie „Computermaus“). Mit Server erkennt sie das genaue Modell, z. B. „Logitech MX Master 3S“.

## Was kostet das?

- **Cloudflare Workers**: das Gratis-Kontingent reicht für den privaten Gebrauch locker aus.
- **Anthropic API**: wird pro Nutzung abgerechnet. Grob **ca. 1 Cent pro Erkennung** mit dem Standardmodell `claude-opus-5-5` bei niedrigem Aufwand (Richtwert, kann abweichen).
- Günstiger geht es mit `MODEL = "claude-haiku-5-5"` in der `wrangler.toml`. Das ist deine Entscheidung (etwas weniger genau, dafür billiger).

## Schritt für Schritt

### 1. Anthropic-Konto und API-Key
1. Auf <https://console.anthropic.com> registrieren.
2. Unter „Billing“ etwas Guthaben aufladen (z. B. 5 €).
3. Unter „API Keys“ einen neuen Key erzeugen und kurz aufbewahren (beginnt mit `sk-ant-…`).
4. **Dringend empfohlen: Ausgabenlimit setzen** (in der Console unter „Limits“ bzw. „Billing“), z. B. 5 € pro Monat. So kann nichts aus dem Ruder laufen, selbst wenn jemand deine Worker-URL findet.

### 2. Cloudflare-Konto
Kostenloses Konto auf <https://dash.cloudflare.com/sign-up> anlegen.

### 3. Worker installieren und veröffentlichen
Du brauchst [Node.js](https://nodejs.org) (Version 20 oder neuer). Dann im Terminal:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

- `wrangler login` öffnet den Browser zur Anmeldung.
- `secret put` fragt nach dem Key; einfügen und Enter drücken. Der Key wird verschlüsselt bei Cloudflare gespeichert und steht nirgends im Code.
- Am Ende zeigt `wrangler deploy` die URL, z. B. `https://scandeals-ai.<dein-name>.workers.dev`.

### 4. URL in der App eintragen
1. ScanDeals öffnen und oben auf das **Zahnrad** tippen (Einstellungen).
2. Bei „KI-Server-URL“ die Worker-URL einfügen (ohne `/` am Ende).
3. **„Verbindung testen“** tippen. Bei Erfolg erscheint „KI-Erkennung aktiv“.
4. Speichern.

Zum Abschalten in den Einstellungen „Entfernen“ wählen, dann läuft die App wieder im Gratis-Modus.

## Erlaubte Webseiten (CORS) ändern

Nur Seiten aus `ALLOWED_ORIGINS` dürfen den Worker nutzen. Standard in `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://ysfbzn0301.github.io,http://localhost:8080"
```

Mehrere Einträge werden mit Komma getrennt. Die Schreibweise muss **exakt** stimmen (mit `https://`, ohne `/` am Ende). Liegt deine App unter einer anderen Adresse, trage sie hier ein und führe danach erneut `npx wrangler deploy` aus.

## Lokal testen

1. Datei `worker/.dev.vars` anlegen (wird nicht ins Git übernommen):
   ```
   ANTHROPIC_API_KEY=sk-ant-dein-key
   ```
2. Starten:
   ```bash
   npx wrangler dev
   ```
   Der Worker läuft dann auf `http://localhost:8787`. Diese Adresse in der App als KI-Server-URL eintragen. Die App selbst muss von einer erlaubten Adresse kommen, z. B. `http://localhost:8080`.
3. Schnelltest: `curl http://localhost:8787/health` liefert `{"ok":true,"model":"…","configured":true}`.

Die automatischen Tests (ohne Netzwerk, ohne Key) startest du mit `npm test`.

## Schnittstellen

- `GET /health` gibt `{ok, model, configured}` zurück.
- `POST /identify` mit `{"image": "<Base64-JPEG ohne Präfix>", "hint": "mouse"}` gibt `{is_product, name, brand, model, category, confidence, search_query, barcode}` zurück. Fehler kommen als `{"error": "…"}` mit passendem Statuscode (400, 403, 413, 422, 429, 500, 502).

## Schutzmaßnahmen und Grenzen

- Bilder dürfen höchstens 1,5 MB groß sein und müssen gültiges Base64 sein.
- Pro IP sind höchstens 20 Anfragen pro Minute erlaubt. Das ist nur eine **Best-Effort-Bremse im Arbeitsspeicher**: Sie gilt pro Worker-Instanz und wird bei einem Neustart zurückgesetzt. Für harte Limits richte in Cloudflare unter „Security → WAF → Rate limiting rules“ eine Regel ein.
- CORS schützt nur vor fremden Webseiten im Browser, nicht vor Skripten (`curl`). Das **Ausgabenlimit bei Anthropic** ist deshalb dein wichtigster Schutz.
- Fehlerdetails und Schlüssel werden nie an die App gesendet.
