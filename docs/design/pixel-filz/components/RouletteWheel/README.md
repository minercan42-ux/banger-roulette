# RouletteWheel

Das Genre-Rad: Pixel-Roulette mit Glühbirnenkranz, Zeiger, der an jedem Segment zuckt, und einem Shake beim Stillstand (FR-10, AK-1).

**Aufbau:** `div.br-wheel > div.br-wheel__pointer + svg.br-wheel__disc + div.br-wheel__hub`. Segmente im SVG: abwechselnd `red` (Text `card-ink`) und `well` (Text `cream`), Segment 0 in `swirl-green` wie die Null beim Roulette. Rand `edge` + `gold-deep`, Glühbirnen `gold` (blinken mit `ease-pixel`).

**Consumer liefert:** Genre-Liste (Reihenfolge = Segmentreihenfolge, für alle Clients identisch), Ziel-Index und Jitter vom Host (injizierte RNG, vor Start festgelegt), Startzeit.

**Deterministischer Spin:**

- Zielwinkel = aktueller Winkel + 6 volle Umdrehungen + Rest bis zur Segmentmitte des Ziels + Jitter (max. ±30 % der Segmentbreite).
- Winkel pro Frame = Start + Distanz × `ease-wheel`(t / `dur-spin`). Keine Physik, kein Zufall im Client, damit alle Clients denselben Pfad laufen.
- Ändert sich `floor(winkel / segmentbreite)`, zuckt der Zeiger (`.is-tick`) und optional ein Klick-Sound.
- Am Ende: `.br-shake` auf den Screen, `GenrePlate` poppt rein. Während des Spins läuft der Backdrop-Wirbel mit `1 + 4 × (1 - t)` facher Geschwindigkeit.

**Motion 14:** `animate(rotate, target, { duration: 2.58, ease: [0.12, 0.62, 0.08, 1], onUpdate: checkTick })` (`duration` = `--dur-spin`, 2580 ms).

**Reduced motion:** kein Spin, Rad steht direkt auf dem Ziel, Plakette blendet ein.
