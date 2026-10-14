# Progress

Segmentierter Pixel-Balken für den Fortschritt des Clips in der Playback-Phase.

**Markup:** `div.br-progress[role=progressbar] > div.br-progress__fill` mit `style.width` in Prozent. Blau: `.br-progress--blue` (z.B. Vorschau im Voting).

**Consumer liefert:** Fortschritt (aus dem Player, ca. 4x pro Sekunde), `aria-valuenow` in Sekunden.

**Motion:** Breite gleitet linear über 250ms zwischen Updates.
