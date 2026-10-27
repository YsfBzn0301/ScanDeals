# PreisFuchs – PWA Preisvergleich (Spezifikation)

Sprache der UI: Deutsch. Reines Vanilla-JS (ES Modules), kein Build-Schritt. Statisch hostbar (z. B. GitHub Pages) – alle Pfade RELATIV (`./`).

## Dateien
| Datei | Zuständig |
|---|---|
| index.html, styles.css, js/app.js, js/api.js, js/scanner.js | App-Agent (Sonnet) |
| manifest.webmanifest, sw.js, icons/*, README.md | PWA-Agent (Haiku) |

## Verträge zwischen den Teilen
- index.html bindet ein: `<link rel="manifest" href="./manifest.webmanifest">`, `<meta name="theme-color" content="#ff6a00">`, `<link rel="icon" href="./icons/icon.svg">`, `<link rel="apple-touch-icon" href="./icons/icon-192.png">`, `styles.css`, `<script type="module" src="./js/app.js">`.
- app.js registriert `./sw.js` (`navigator.serviceWorker.register('./sw.js')`).
- sw.js: App-Shell cachen (index.html, styles.css, js/app.js, js/api.js, js/scanner.js, manifest, icons). Strategie: Shell = cache-first mit Hintergrund-Update; API-Anfragen an `*.openfoodfacts.org` = network-first, Fallback Cache; alles andere (CDN) = stale-while-revalidate. Cache-Name versioniert `preisfuchs-v1`, alte Caches bei activate löschen.
- Icons: icons/icon.svg, icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png. Farbe #ff6a00 (Fuchs/Preisschild-Motiv).

## Datenquellen (alle kostenlos, CORS-fähig, kein API-Key)
1. Produkt per Barcode: `https://world.openfoodfacts.org/api/v2/product/{code}.json?fields=code,product_name,product_name_de,brands,quantity,image_front_small_url`
   (Fallback bei status 0: gleiche URL bei world.openproductsfacts.org und world.openbeautyfacts.org)
2. Produktsuche per Name: `https://world.openfoodfacts.org/cgi/search.pl?search_terms={q}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,product_name_de,brands,quantity,image_front_small_url&countries_tags_en=germany`
3. Preise: Open Prices `https://prices.openfoodfacts.org/api/v1/prices?product_code={code}&order_by=-date&size=100`
   Antwort `{items:[...], total}`; jedes item: `price`, `currency`, `date`, `price_is_discounted`, `price_without_discount`, `location:{type:'OSM'|'ONLINE', osm_name, osm_brand, osm_display_name, osm_address_city, osm_address_postcode, osm_lat, osm_lon, website_url}`.
   Auch Suche ohne Barcode möglich: `?product_name__like=` NICHT verlässlich → bei Freitext zuerst Produkt suchen, dann Preise per Code.

## Logik Preise
- Pro Händler (Gruppierung: location.osm_brand || osm_name || website_url-Host) den NEUESTEN Preis behalten; Einträge älter als 12 Monate ausblenden (Toggle "ältere anzeigen").
- Sortierung günstig → teuer. Ganz oben "Bestpreis"-Badge. Datum als "Stand: 12.10.2026" und relativ ("vor 3 Tagen"). Währung mit Intl.NumberFormat('de-DE').
- Jede Zeile zeigt: Händlername, Preis, ggf. Angebot (durchgestrichener Normalpreis), Ort/Stadt der Meldung, Datum.
- Ladengeschäft (type OSM):
  - Button "Filiale der Meldung" → `https://www.google.com/maps/search/?api=1&query={lat},{lon}`
  - Button "Alle Filialen in Google Maps" → `https://www.google.com/maps/search/?api=1&query={encodeURIComponent(brand + ' Filiale')}` ; wenn Nutzer-Standort bekannt (optional, Button "Standort nutzen"): `https://www.google.com/maps/search/{encodeURIComponent(brand)}/@{lat},{lon},13z`
- Online (type ONLINE): Button "Zum Shop" → website_url.
- Immer zusätzlich Abschnitt "Weitere Preise online prüfen" mit Such-Links: idealo (`https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=`), Google Shopping (`https://www.google.com/search?tbm=shop&q=`), Amazon.de (`https://www.amazon.de/s?k=`), geizhals.de (`https://geizhals.de/?fs=`) – mit Produktname (+Marke) bzw. Barcode.
- Keine Preise vorhanden → freundlicher Hinweis + Online-Links + Link "Preis selbst melden" (`https://prices.openfoodfacts.org/prices/add/single?code={code}`).

## UI
- Mobile-first, Header "PreisFuchs", Suchfeld + "Suchen"-Button + großer "Scannen"-Button (Kamera-Icon).
- Freitextsuche → Ergebnisliste Produkte (Bild, Name, Marke, Menge) → Klick → Preisansicht. Eingabe nur aus Ziffern (8–14) = Barcode direkt.
- Scanner: Vollbild-Overlay mit Video, Zielrahmen, Abbrechen; native `BarcodeDetector` (ean_13, ean_8, upc_a, upc_e) sonst Fallback ZXing per dynamic import von `https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm`. Rückkamera (`facingMode: environment`). Fehlermeldung bei verweigerter Kamera. Kamera nach Treffer sofort stoppen, Vibration 100ms.
- Verlauf der letzten 10 Produkte in localStorage (try/catch), auf Startseite anklickbar.
- Lade-Skeleton, Fehlerzustand mit "Erneut versuchen", Offline-Hinweis (navigator.onLine).
- Hell/Dunkel per prefers-color-scheme, CSS-Variablen, Akzent #ff6a00.
- Hinweis im Footer: "Preisdaten: Open Prices / Open Food Facts (Community, ODbL). Preise können abweichen."
- Hash-Routing: `#/`, `#/suche/{q}`, `#/produkt/{code}` (Zurück-Button funktioniert).
