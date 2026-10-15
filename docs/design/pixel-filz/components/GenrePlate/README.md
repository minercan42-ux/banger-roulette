# GenrePlate

Rote Plakette mit dem gezogenen Genre, poppt nach dem Spin rein und pulsiert danach leicht.

**Markup:** `div.br-genre.is-in[role=status][aria-live=polite] > span.br-genre__kicker + strong.br-genre__name`.

**Consumer liefert:** Genre-Name in der aktuellen Sprache (aus `genres.json`), Kicker-Text aus i18n.

**Regeln:** Name in Großbuchstaben, Stil `genre`, `cream` auf `red` (Display-Größe, 3.2:1 erlaubt). Kicker `card-ink`. Im Modus "Ein Genre" ohne Rad direkt mit `.is-in` einblenden.

**Motion:** `br-pop-in` (`dur-pop`, `ease-spring`), danach alle 2.6s `br-bump` auf dem Namen. Reduced motion: Einblenden.
