# Leaderboard

Zwischenstand-Liste im Panel, bei der Spieler nach jeder Runde mit Federeffekt die Plätze tauschen (FR-61).

**Markup:** `ol.br-lb > li.br-lb__row > span.br-lb__pos + span.br-lb__name + span(span.br-lb__pts + span.br-lb__delta)`. Eigener Spieler `.is-me`. Delta `.is-up` (grün, Dreieck hoch) oder `.is-down` (`red-text`, Dreieck runter), immer mit Zahl.

**Consumer liefert:** sortierte Spieler, Punkte, Rang vorher. Gleichstand = geteilter Platz (FR-53): gleiche Positionsnummer.

**Motion:** FLIP über `dur-reveal` mit `ease-spring`, Punkte bekommen `.br-bump`. Motion 14: `<motion.li layout transition={{ duration: 0.6, ease: [0.3, 1.6, 0.5, 1] }}>`. Reduced motion: Liste springt in die neue Reihenfolge.
