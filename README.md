# Bildtransformer

Lokale Foto-App für Android und PC: erkennt Schrift auf Fotos automatisch und entfernt sie, dazu Stil-, Farb- und Korrekturwerkzeuge und ein Eingabefeld für freie Kommandos. Alle Bilder bleiben auf dem Gerät – es gibt keinen Server, der Fotos empfängt.

## Installation über GitHub Pages

1. Neues **öffentliches** Repository anlegen, z. B. `bildtransformer` (Pages ist im kostenlosen Konto nur für öffentliche Repos verfügbar; im Repo liegt nur Programmcode).
2. Den **Inhalt** dieses Ordners hochladen (nicht den Ordner selbst), sodass `index.html` direkt im Repo liegt. Alle Dateien sind kleiner als 25 MB und gehen auch über „Add file → Upload files“ im Browser.
3. Im Repo: **Settings → Pages → Branch: main / (root) → Save**. Nach ein bis zwei Minuten ist die App unter `https://<benutzername>.github.io/bildtransformer/` erreichbar.
4. Die Adresse auf dem Handy in **Chrome** öffnen, ein Foto bearbeiten (lädt einmalig ca. 33 MB KI-Modelle) und über das Menü **„Zum Startbildschirm hinzufügen“** bzw. **„App installieren“** wählen.

Danach startet die App wie eine normale App, funktioniert offline und erscheint im Android-Menü **„Teilen“** – Fotos lassen sich direkt aus der Galerie an den Bildtransformer schicken.

**Selbst prüfen, dass nichts hochgeladen wird:** Nach dem ersten Start den Flugmodus einschalten und ein Foto bearbeiten.

## Am PC ohne Hosting

Im Ordner ein Terminal öffnen und `python -m http.server 8000` starten, dann `http://localhost:8000` in Chrome oder Edge öffnen. Direktes Öffnen der `index.html` per Doppelklick funktioniert nicht (Browser-Sicherheitsregeln für Web-Apps).

## Funktionen

| Bereich | Funktion |
|---|---|
| Schrift | automatische Erkennung (auch schräg), Rekonstruktion in voller Auflösung, „Verbessern“ für einen zweiten Durchgang, „Nachmalen“ für übersehene Stellen |
| Objekte | „Objekt weg“: übermalen und entfernen lassen |
| Korrektur | Auto, Heller/Dunkler, Kontrast, Wärmer/Kälter, Schärfer/Weicher, Kräftiger/Blasser |
| Stil | Retro (Sepia, Körnung, Vignette), Schwarzweiß, kontrastreiches Schwarzweiß |
| Farbe | Farbton antippen und entfernen, „Nur eine Farbe behalten“, Farbstich entfernen (per Kommando) |
| Kommandos | freie Sätze wie „etwas wärmer und das Rot raus“, „deutlich heller, mehr Kontrast“, „nur Blau behalten“, „Gelbstich entfernen“, „Retro-Look“, „rückgängig“, „zurück zum Original“ |
| Qualität | Standard (MI-GAN, schnell) oder Höchste Qualität (LaMa, einmalig 208 MB, langsamer) unter „Mehr“ |

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche (Entwurf B+) |
| `app.js` | Bedienung, Vergleichsregler, Pinsel, Verlauf, Speichern, Kommandos |
| `worker.js` | KI im Hintergrund-Thread: Modelle laden/zwischenspeichern, Erkennung, Rekonstruktion, Filter |
| `core.js` | Bildverarbeitung: Masken, Kachel-Rekonstruktion, Filter, Kommando-Interpreter |
| `sw.js` | Offline-Betrieb, Mehrkern-Berechnung, Empfang über „Teilen“ |
| `ort/` | onnxruntime-web 1.30.0 (Rechen-Engine) |
| `models/` | Texterkennungsmodell (PP-OCRv4 det) |

Die Rekonstruktionsmodelle werden beim ersten Gebrauch von Hugging Face geladen (Ersatz: jsDelivr/unpkg) und danach im Browser gespeichert.

## Grenzen

- Rekonstruktion erfindet plausiblen Inhalt; bei Gesichtern, Schrift im Motiv oder feinen Strukturen kann sie danebenliegen.
- Fotos über 4096 Pixel Kantenlänge werden auf 4096 verkleinert.
- Das Kommandofeld versteht die eingebauten Werkzeuge. Echtes Neu-Malen („Himmel als Sonnenuntergang“) ist nicht enthalten.
- „Höchste Qualität“ braucht viel Arbeitsspeicher; auf älteren Handys kann es abbrechen – dann auf Standard zurückstellen.

## Drittanbieter

- onnxruntime-web – MIT-Lizenz, Microsoft
- PP-OCRv4 Detection (PaddleOCR) – Apache 2.0, PaddlePaddle; ONNX-Fassung aus dem npm-Paket `@gutenye/ocr-models`
- MI-GAN – MIT-Lizenz, Picsart AI Research
- LaMa – Apache 2.0, Samsung AI / advimman; ONNX-Fassung von Carve
