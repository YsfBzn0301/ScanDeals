# ScanDeals – Preise scannen & vergleichen

ScanDeals ist eine installierbare Web-App (PWA), mit der du Preise für Lebensmittel und Produkte findest und vergleichst. Sie läuft im Browser, ohne Build-Schritt und ohne Anmeldung.

**Live:** https://ysfbzn0301.github.io/ScanDeals/

## Was die App kann

- **Splash-Startbildschirm:** Kurze Begrüßung beim Start, danach direkt zur Suche.
- **Produkt per Barcode finden:** Barcode mit der Kamera scannen (EAN/UPC) oder die Ziffern direkt eingeben.
- **KI-Produkterkennung:** Ein Produkt vor die Kamera halten, statt einen Barcode zu scannen (siehe unten).
- **Live-Scanner im Sucher:** Die Kamera läuft direkt im Sucher; Barcodes werden erkannt, sobald sie im Bild sind. Mit der Taschenlampe-Taste lässt sich das Licht bei schlechten Lichtverhältnissen zuschalten (sofern das Gerät es unterstützt).
- **Produkt per Name suchen:** Freitextsuche mit Ergebnisliste (Bild, Name, Marke, Menge).
- **Preise vergleichen:** Pro Händler der neueste Preis, sortiert von günstig nach teuer, mit Bestpreis-Markierung. Angebote zeigen den durchgestrichenen Normalpreis. Meldungen älter als 12 Monate sind standardmäßig ausgeblendet. Als Duplikat markierte Preise werden ausgeblendet.
- **Händler-Logos:** Pro Händler ein rundes Logo (Open-Prices-Markenbild, falls vorhanden), sonst eine Initial-Kachel; Online-Shops mit Globus-Symbol.
- **Preise in der Nähe:** Nach „Standort nutzen“ zeigt jede Karte die Entfernung. Der Schalter „Überall | In der Nähe“ begrenzt die Liste auf Läden im Umkreis von 5, 10 oder 25 km (Auswahl wird gemerkt); Online-Preise erscheinen nur bei „Überall“. Der Standort bleibt nur im Arbeitsspeicher.
- **Preis-Bottom-Sheet:** Details öffnen sich als Panel von unten, das sich auf halbe und volle Höhe ziehen lässt.
- **Filialen und Shops:** Ladengeschäfte lassen sich in Google Maps öffnen, Online-Händler verlinken direkt zum Shop.
- **Weitere Preise prüfen:** Links zu idealo, Google Shopping, Amazon.de und Geizhals.
- **Verlauf:** Die letzten 10 angesehenen Produkte stehen auf der Startseite.
- **Dark Mode:** Dunkle Oberfläche (#0D0F12) mit Cyan-Purple-Akzenten.
- **Offline-Nutzung:** Die App-Oberfläche wird gecacht und startet auch ohne Netz; Preisdaten brauchen eine Verbindung.

## KI-Produkterkennung

Im Sucher lässt sich zwischen drei Erkennungsmodi wählen:

- **Auto:** Barcodes und Produkte werden gleichzeitig erkannt. Wer einen Barcode hält, bekommt sofort den Barcode-Treffer.
- **Barcode:** Nur Barcodes werden gelesen, wie bisher.
- **Objekt:** Die Kamera erkennt Produkte im Bild, ohne dass ein Barcode nötig ist.

**Gratis-Modus (Standard):** Die Erkennung grober Kategorien (z. B. „Computermaus“, „Flasche“) läuft direkt im Handy mit TensorFlow.js. Das Modell (ca. 6 MB) wird beim ersten Mal geladen und danach im Cache der App gehalten. Danach funktioniert die Erkennung auch ohne Server.

**Genaue Erkennung mit KI-Server:** Für konkrete Modelle wie „Logitech MX Master 3S“ erkennt ein eigener KI-Server mit Claude das Produkt. Die Einrichtung beschreibt [worker/README.md](./worker/README.md). Danach die Server-URL in der App unter **Einstellungen** (Zahnrad-Symbol) eintragen. Ohne URL bleibt die App im Gratis-Modus.

**Datenschutz:**

- Im Gratis-Modus verlassen keine Kamerabilder das Handy.
- Mit KI-Server wird nur der Bildausschnitt des erkannten Objekts an den eigenen Server gesendet, von dort an Anthropic. Der API-Schlüssel liegt ausschließlich im Server.

**Händler-Links:** Zu einem erkannten oder gesuchten Produkt verlinkt die App auf MediaMarkt, Saturn, Amazon, eBay, idealo, Google Shopping und Geizhals.

## Datenquellen

- **Open Food Facts** (Produktdaten, Namen, Bilder, Nährwerte): https://world.openfoodfacts.org – Abruf per Barcode über die **API v3.6**, bei technischen Fehlern (Netz, Timeout, 5xx, unerwartetes Format) mit Fallback auf API v2. Die Textsuche nutzt die klassische Suche (`/cgi/search.pl`), da v3 noch keine Volltextsuche bietet.
- **Open Prices** (Preismeldungen der Community, API v1): https://prices.openfoodfacts.org

Beide Datenbanken sind frei verfügbar und stehen unter der **Open Database License (ODbL)**. Die Preisdaten stammen von Nutzerinnen und Nutzern, ScanDeals ist nicht mit Open Food Facts oder Open Prices verbunden. Keine API-Schlüssel nötig.

- **Google Shopping über SerpApi** (optional, Kontingent/kostenpflichtig): Echtzeitpreise von Händlern wie Amazon, MediaMarkt oder Otto, besonders nützlich für Technik und bei unbekannten Barcodes (Suche per GTIN). Läuft nur über den eigenen ScanDeals-Server (Cloudflare Worker, Endpunkt `/shopping`) mit eigenem SerpApi-Schlüssel – Einrichtung und Kontingent-Hinweise siehe [worker/README.md](./worker/README.md). Erscheint zusammen mit der Open Price Engine im Abschnitt „Tagesaktuell online“, Mehrfachpackungen werden mit „6er-Pack“ gekennzeichnet.
- **Open Price Engine** (optional, kostenpflichtig): tagesaktuelle Onlineshop-Preise u. a. von Aldi Süd, Lidl, Globus und Alnatura im Abschnitt „Tagesaktuell online“. Läuft nur über den eigenen ScanDeals-Server (Cloudflare Worker) mit eigenem API-Schlüssel – Einrichtung siehe [worker/README.md](./worker/README.md). Abgleich nur über den Produktnamen (keine Barcode-Suche), daher kennzeichnet die App „gleiche Größe“, „andere Größe“ oder „ähnliches Produkt“.

Welche Quellen aktiv sind, zeigt die App unter **Einstellungen** (Chips „Tagespreise“ und „Echtzeitpreise“). Bei einem Barcode, der in Open Food Facts fehlt, sucht die App per GTIN in Google Shopping; die Textsuche ohne Treffer zeigt „Online gefunden“.

## Projektstruktur

```
index.html          Oberfläche (Seite, Sucher, Bottom-Sheet)
styles.css          Design, Dark Mode
manifest.webmanifest  PWA-Manifest
sw.js               Service Worker (Offline-Cache, Cache-Name scandeals-v10)
js/app.js           Routing, Suche, Produktansicht, Einstellungen
js/api.js           Datenzugriff (Open Food Facts / Open Prices)
js/scanner.js       Kamera und Barcode-Erkennung
js/vision.js        Objekterkennung im Handy (TensorFlow.js, COCO-SSD, lazy geladen)
js/overlay.js       Canvas-Overlay mit Bounding-Box im Sucher
js/ki.js            Live-KI-Sitzung und Anfragen an den KI-Server
js/config.js        KI-Server-Adresse und Scan-Modus
js/motion.js, sheet.js, splash.js  Animationen, Bottom-Sheet, Startbildschirm
icons/              App-Icons
worker/             KI-Server (Cloudflare Worker), siehe worker/README.md
```

## Lokal starten

Im Projektordner:

```bash
python3 -m http.server 8080
```

Dann im Browser http://localhost:8080 öffnen.

Hinweis: Die Kamera (Barcode-Scanner) funktioniert nur über **HTTPS** oder auf **localhost**.

## Veröffentlichen

Die App ist rein statisch und kann bei jedem Hoster mit HTTPS betrieben werden. Empfohlen:

- **GitHub Pages:** Repository auf GitHub hochladen, in den Einstellungen unter *Pages* die Quelle (Branch/Ordner mit `index.html`) wählen. Die Adresse hat dann automatisch HTTPS.
- **Netlify:** Projektordner per Drag & Drop auf netlify.com hochladen oder ein Git-Repository verbinden.

Die GitHub-Pages-Adresse ist **case-sensitiv**: Der Pfad heißt `/ScanDeals/` mit großem S und D. Ein Aufruf mit anderer Schreibweise (z. B. `/scandeals/`) führt zu einem 404-Fehler.

HTTPS ist nötig, damit sich die App installieren lässt (Service Worker) und die Kamera funktioniert. Alle Pfade in der App sind relativ, sie läuft also auch in einem Unterordner.

## Installation auf dem Handy

- **Android (Chrome):** Seite öffnen, Menü (⋮) → *Zum Startbildschirm hinzufügen* bzw. *App installieren*.
- **iPhone (Safari):** Seite öffnen, Teilen-Symbol → *Zum Home-Bildschirm*.

Danach startet ScanDeals wie eine normale App im Vollbild.

## Echtzeit-Kontingent & eigener SerpApi-Schlüssel

Echtzeitpreise (Google Shopping) nutzen das monatliche SerpApi-Kontingent deines ScanDeals-Servers. Bereits geladene Preise kommen zuerst aus dem Server-Cache und kosten nichts. Wird das Kontingent knapp, lädt die App nicht mehr automatisch, sondern zeigt vorher einen Hinweis („Nur noch X Echtzeit-Suchen diesen Monat“) und sucht erst auf Tipp. Ist es aufgebraucht, verweist die App auf [SerpApi-Tarife](https://serpapi.com/pricing).

Unter *Einstellungen → Eigener SerpApi-Schlüssel (optional)* kannst du einen eigenen SerpApi-Schlüssel hinterlegen. Er bleibt auf dem Gerät (localStorage) und wird nur im Header `X-SerpApi-Key` an deinen ScanDeals-Server gesendet; die Suchen laufen dann über dein eigenes Kontingent. Der Server-Teil ist in `worker/README.md` beschrieben.

## Grenzen

- **Preise sind Community-Meldungen.** Sie können veraltet sein oder vom aktuellen Preis abweichen. Der Stand (Datum) wird jeweils angezeigt.
- **Nicht jedes Produkt hat Preise.** Wenn keine Meldungen vorliegen, zeigt die App Such-Links zu idealo, Google Shopping, Amazon und Geizhals und einen Link, um selbst einen Preis zu melden.
- **Barcode nicht gefunden?** Dann hilft oft die Suche nach dem Produktnamen.

### Limit pro Gerät

Mit dem gemeinsamen Server-Schlüssel ist die Zahl echter Echtzeit-Suchen pro Gerät und Kalendermonat begrenzt (Standard 10, einstellbar am Server). Die App erzeugt dafür einmalig eine anonyme Geräte-ID (`localStorage`, `scandeals.deviceId`) und sendet sie als Header `X-Device-Id`. Gecachte Treffer und Suchen mit eigenem SerpApi-Schlüssel zählen nicht. Vor dem Limit warnt die App („Noch X von Y Echtzeit-Suchen auf diesem Gerät diesen Monat“), danach zeigt sie das Datum, ab dem wieder gesucht werden kann, und verweist auf einen eigenen Schlüssel. Wer den Browser-Speicher löscht, bekommt eine neue ID – deshalb gibt es am Server zusätzlich ein großzügigeres Limit pro IP-Adresse (siehe `worker/README.md`).
