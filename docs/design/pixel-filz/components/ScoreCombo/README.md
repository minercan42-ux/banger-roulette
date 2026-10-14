# ScoreCombo

Die Rundenpunkte als Combo: blaue Stimmen-Box plus rote Jackpot-Box gleich goldene Summe, Ziffer für Ziffer hochgezählt.

**Markup:** `div.br-combo > .br-combo__box--votes + .br-combo__op + .br-combo__box--bonus + .br-combo__op + .br-combo__box--total`, darunter `.br-combo__caption`.

**Consumer liefert:** Borda-Punkte, Bonus (+2 oder 0), Summe; bei Genre-Fail eine negative Bonus-Box mit `red-text`-Badge daneben.

**Motion:** Erst Stimmen über `dur-count` hochzählen, dann Bonus, dann Summe. Jede neue Zahl bekommt `.br-bump`. Motion 14: `animate(0, value, { duration: 0.9, onUpdate })` und `bump` als Keyframes `scale: [1, 1.18, 1]`. Reduced motion: Endwerte sofort.

**a11y:** Container `aria-live="polite"` + `aria-atomic="true"`, aber erst die Endsumme reinschreiben, nicht jede Zwischenzahl ansagen lassen.
