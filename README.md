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
| Schrift | automatische Erkennung (auch schräg), zusätzliche Suche nach blasser Schrift, Rekonstruktion in voller Auflösung, „Verbessern“ für einen zweiten Durchgang, „Nachmalen“ für übersehene Stellen |
| Transparente Schrift | Farbe und Deckkraft werden geschätzt und die Schrift herausgerechnet – das Foto darunter bleibt erhalten statt neu erfunden zu werden (bis ca. 65 % Deckkraft; stärker deckende Schrift wird rekonstruiert) |
| Objekte | „Objekt weg“: übermalen und entfernen lassen |
| Korrektur | Auto, Heller/Dunkler, Kontrast, Wärmer/Kälter, Schärfer/Weicher, Kräftiger/Blasser |
| Stil | Retro (Sepia, Körnung, Vignette), Schwarzweiß, kontrastreiches Schwarzweiß |
| Farbe | Farbton antippen und entfernen, „Nur eine Farbe behalten“, Farbstich entfernen (per Kommando) |
| Kommandos | freie Sätze wie „etwas wärmer und das Rot raus“, „deutlich heller, mehr Kontrast“, „nur Blau behalten“, „Gelbstich entfernen“, „Retro-Look“, „rückgängig“, „zurück zum Original“ |
| Qualität | Standard (MI-GAN, schnell) oder Höchste Qualität (LaMa, einmalig 208 MB, langsamer; nur auf Geräten mit mindestens 8 GB Arbeitsspeicher) unter „Mehr“ |
| Reset | schließt das aktuelle Foto und zeigt wieder die leere Fläche (mit Rückfrage, wenn schon bearbeitet wurde) |

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche (Entwurf B+) |
| `app.js` | Bedienung, Vergleichsregler, Pinsel, Verlauf, Speichern, Kommandos |
| `worker.js` | Hintergrund-Thread: Modelle laden/zwischenspeichern, Ablauf von Erkennung und Rekonstruktion, Filter |
| `model-host.js` | kurzlebiger Rechenprozess für genau ein KI-Modell (wird nach jeder Bearbeitung beendet) |
| `core.js` | Bildverarbeitung: Masken, Kachel-Rekonstruktion, Filter, Kommando-Interpreter |
| `sw.js` | Offline-Betrieb, Mehrkern-Berechnung, Empfang über „Teilen“ |
| `ort/` | onnxruntime-web 1.30.0 (Rechen-Engine) |
| `models/` | Texterkennungsmodell (PP-OCRv4 det) |

Die Rekonstruktionsmodelle werden beim ersten Gebrauch von Hugging Face geladen (Ersatz: jsDelivr/unpkg) und dauerhaft im Browser gespeichert – in Teilen zu 4 MB, jeder Teil sofort. Bricht die Verbindung ab, wird an der Abbruchstelle fortgesetzt (automatisch bis zu 6 Versuche, danach beim nächsten Start); bereits geladene Daten werden nie erneut übertragen.

Das große Modell für „Höchste Qualität“ lädt im Hintergrund, solange wird mit Standard gearbeitet. Im Mobilfunknetz fragt die App vorher und kann den Download auf WLAN verschieben. Unter „Mehr“ steht, wie viel geladen ist und ob der App-Speicher dauerhaft gesichert ist. Ist er das nicht, darf Android ihn bei Speichermangel leeren – dann die App über das Chrome-Menü installieren.

## Arbeitsspeicher

Die Rechen-Engine (WebAssembly) kann belegten Speicher nicht wieder abgeben. Deshalb läuft jedes KI-Modell in einem eigenen Rechenprozess, und es ist immer nur eines gleichzeitig geladen. Nach jeder Bearbeitung werden alle Rechenprozesse beendet, und das Handy bekommt den Speicher sofort zurück. Gemessen im Browser an einem 6-MP-Foto:

| | vorher | jetzt |
|---|---|---|
| Schrift entfernen (Standard), Spitze | +1.389 MB | +965 MB |
| danach im Ruhezustand | +1.140 MB | +312 MB |
| mit großem Modell (Höchste Qualität), Spitze | alle Modelle gleichzeitig im Speicher | +1.153 MB |

Bildverarbeitungsschritte arbeiten nur noch im Bereich der Schrift statt auf Kopien des ganzen Fotos. Auf Geräten mit höchstens 4 GB Arbeitsspeicher werden Fotos auf 3072 Pixel Kantenlänge begrenzt. Dafür dauert jede Bearbeitung ein paar Sekunden länger, weil die Modelle jedes Mal neu geladen werden (aus dem Gerätespeicher, nicht aus dem Netz).

## Grenzen

- Rekonstruktion erfindet plausiblen Inhalt; bei Gesichtern, Schrift im Motiv oder feinen Strukturen kann sie danebenliegen.
- Sehr blasse Schrift über unruhigem Hintergrund wird nicht immer vollständig automatisch gefunden. Dann mit „Nachmalen“ grob über die Reste malen – die App schätzt Farbe und Deckkraft auch dort und rechnet die Schrift heraus.
- Fotos über 4096 Pixel Kantenlänge werden auf 4096 verkleinert.
- Das Kommandofeld versteht die eingebauten Werkzeuge. Echtes Neu-Malen („Himmel als Sonnenuntergang“) ist nicht enthalten.
- „Höchste Qualität“ braucht kurzzeitig rund 1 GB Arbeitsspeicher und ist erst ab 8 GB (laut Browser) freigegeben. Scheitert es trotzdem, schaltet die App automatisch auf Standard um.

## Drittanbieter

- onnxruntime-web – MIT-Lizenz, Microsoft
- PP-OCRv4 Detection (PaddleOCR) – Apache 2.0, PaddlePaddle; ONNX-Fassung aus dem npm-Paket `@gutenye/ocr-models`
- MI-GAN – MIT-Lizenz, Picsart AI Research
- LaMa – Apache 2.0, Samsung AI / advimman; ONNX-Fassung von Carve
