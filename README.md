# ScanDeals – Preise scannen & vergleichen

ScanDeals ist eine installierbare Web-App (PWA), mit der du Preise für Lebensmittel und Produkte findest und vergleichst. Sie läuft im Browser, ohne Build-Schritt und ohne Anmeldung.

**Live:** https://ysfbzn0301.github.io/ScanDeals/

## Was die App kann

- **Splash-Startbildschirm:** Kurze Begrüßung beim Start, danach direkt zur Suche.
- **Produkt per Barcode finden:** Barcode mit der Kamera scannen (EAN/UPC) oder die Ziffern direkt eingeben.
- **Live-Scanner im Sucher:** Die Kamera läuft direkt im Sucher; Barcodes werden erkannt, sobald sie im Bild sind. Mit der Taschenlampe-Taste lässt sich das Licht bei schlechten Lichtverhältnissen zuschalten (sofern das Gerät es unterstützt).
- **Produkt per Name suchen:** Freitextsuche mit Ergebnisliste (Bild, Name, Marke, Menge).
- **Preise vergleichen:** Pro Händler der neueste Preis, sortiert von günstig nach teuer, mit Bestpreis-Markierung. Angebote zeigen den durchgestrichenen Normalpreis. Meldungen älter als 12 Monate sind standardmäßig ausgeblendet.
- **Preis-Bottom-Sheet:** Details öffnen sich als Panel von unten, das sich auf halbe und volle Höhe ziehen lässt.
- **Filialen und Shops:** Ladengeschäfte lassen sich in Google Maps öffnen, Online-Händler verlinken direkt zum Shop.
- **Weitere Preise prüfen:** Links zu idealo, Google Shopping, Amazon.de und Geizhals.
- **Verlauf:** Die letzten 10 angesehenen Produkte stehen auf der Startseite.
- **Dark Mode:** Dunkle Oberfläche (#0D0F12) mit Cyan-Purple-Akzenten.
- **Offline-Nutzung:** Die App-Oberfläche wird gecacht und startet auch ohne Netz; Preisdaten brauchen eine Verbindung.

## Datenquellen

- **Open Food Facts** (Produktdaten, Namen, Bilder): https://world.openfoodfacts.org
- **Open Prices** (Preismeldungen der Community): https://prices.openfoodfacts.org

Beide Datenbanken sind frei verfügbar und stehen unter der **Open Database License (ODbL)**. Die Preisdaten stammen von Nutzerinnen und Nutzern, ScanDeals ist nicht mit Open Food Facts oder Open Prices verbunden. Keine API-Schlüssel nötig.

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

## Grenzen

- **Preise sind Community-Meldungen.** Sie können veraltet sein oder vom aktuellen Preis abweichen. Der Stand (Datum) wird jeweils angezeigt.
- **Nicht jedes Produkt hat Preise.** Wenn keine Meldungen vorliegen, zeigt die App Such-Links zu idealo, Google Shopping, Amazon und Geizhals und einen Link, um selbst einen Preis zu melden.
- **Barcode nicht gefunden?** Dann hilft oft die Suche nach dem Produktnamen.
