# SongCard

Ein eingereichter Song als Spielkarte: verdeckt mit Pixel-Muster, aufgedeckt mit Thumbnail, Titel und Kanal.

**Markup:** `button.br-card > span.br-card__inner > (span.br-card__back + span.br-card__face.br-card__face--front)`. Vorderseite: `__corner`, `__mid` (mit `__thumb`, `__title`, `__sub`), `__corner--end`.

**Zustände:**

| Klasse                          | Bedeutung                                                    |
| ------------------------------- | ------------------------------------------------------------ |
| (keine)                         | verdeckt: Rückseite sichtbar (Einreichphase, andere Spieler) |
| `.is-flipped`                   | aufgedeckt (ab Playback)                                     |
| `.is-selected` + `aria-pressed` | im Voting gewählt, Goldrand, angehoben                       |
| `.is-winner`                    | Rundensieger, `glow-gold`                                    |
| `.is-dim`                       | eigener Song, nicht wählbar                                  |
| `span.br-card__rank`            | Platz im Ranking                                             |
| `span.br-card__owner`           | Owner-Stempel im Reveal (AK-3: erst dann!)                   |
| `span.br-card__flag`            | Platz für ein Genre-Fail-Badge                               |

**Hand:** Karten in `.br-hand`, überlappend um 24px. Jede Karte bekommt `--r` (-6deg bis 9deg) und `.br-wobble` mit versetztem `animation-delay`.

**Consumer liefert:** Nummer, Titel, Kanal, Thumbnail-URL (`i.ytimg.com`, CSP ok), `aria-label` mit Nummer und Titel, nie mit Owner vor dem Reveal.

**Motion:** Leerlauf `br-wobble` (`dur-wobble`). Hover/Fokus heben an (`dur-quick`, `ease-spring`, translateY -16px, scale 1.06). Flip `dur-reveal`, `ease-spring` um die Y-Achse. Owner-Stempel knallt mit `br-stamp` drauf. Motion 14: Flip über `animate={{ rotateY: flipped ? 180 : 0 }}` mit `transition={{ duration: 0.6, ease: [0.3, 1.6, 0.5, 1] }}`.

**Reduced motion:** kein Wackeln, kein Anheben; Flip und Stempel als 1ms-Wechsel bzw. Einblenden.
