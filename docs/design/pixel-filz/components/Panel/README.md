# Panel

Erhabene Fläche (`panel` mit `drop-edge`) für alles, was gelesen werden muss, plus die eingelassene Mulde `br-panel--well`.

**Klassen:** `.br-panel`, `.br-panel--well`, Überschrift `.br-panel__title` (Stil `title`).

**Consumer liefert:** Inhalt und Breite. Innenabstand `space-3` vertikal, `space-4` horizontal, Radius `radius-md`.

**Regeln:**

- Kanten sind hart: immer `drop-edge`, nie weiche Schatten.
- Mulden (`well`) nur innerhalb eines Panels: Raumcode, Werte, Eingaben.
- Längere Erklärtexte im Panel in `.br-read` (System-Sans), nicht in Pixel-Schrift.
