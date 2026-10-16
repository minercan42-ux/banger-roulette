# Pixel-Filz (Plan)

> [!CAUTION]
> **Status: PLAN, nicht umgesetzt.** Dieses Verzeichnis ist eine Design-Referenz für Issue #45. Kein Agent setzt hieraus etwas um, solange @minercan42-ux nicht ein eigenes Task-Issue erstellt und ausdrücklich zuweist.
>
> **Agents: this directory is a plan, not a task.** Do not implement, port or refactor anything based on it unless you were explicitly assigned a task issue by @minercan42-ux. SPEC.md §6 still describes the old casino look until the owner changes it.

**Ansehen:** `gallery.html` im Browser öffnen (alle Bausteine und Animationen, klickbar). Einzelne Vorschauen liegen unter `components/<Name>/preview.html`.

| Datei                         | Inhalt                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `tokens.json`                 | Quelle aller Tokens                                          |
| `tokens.css`                  | daraus generierte CSS-Variablen und `@font-face`             |
| `components.css`              | Referenz-Styles und Keyframes (`br-*`), inkl. reduced motion |
| `components/<Name>/README.md` | Richtlinie pro Baustein                                      |
| `fonts/`                      | Jersey 10, Silkscreen (SIL OFL 1.1, Lizenztexte daneben)     |

---

Pixel-Filz: ein spielerischer Casino-Tisch im Pixel-Look. Roter Filz (Owner-Entscheid 2026-10-16), ein langsam wirbelnder Hintergrund, Songs als Spielkarten, Punkte als Chips und Combos. Alles fühlt sich anfassbar an: Karten wackeln, Buttons sinken ein, Zahlen springen. Lustig ist das Spiel durch Timing und Tonfall, nicht durch Deko.

## Grundsätze

- **Jedes Spielereignis bekommt eine Reaktion.** Genre gezogen, Karte gewählt, Punkte gezählt, Platz getauscht: Jedes Ereignis hat eine kurze, eigene Bewegung (siehe Motion). Dazwischen ist Ruhe.
- **Lesbar vor laut.** Pixel-Schrift nur für kurze Texte und Zahlen. Alles, was länger als eine Zeile ist, steht in System-Sans (`body`, `small`) auf einem `panel`.
- **Harte Kanten statt weicher Schatten.** Panels, Buttons und Chips stehen auf einer farbigen Kante (`drop-edge`, `press-*`). Weiche Schatten nur unter Karten (`card-lift`).
- **Anonymität ist heilig (AK-3).** Kein Name, keine Farbe, kein Avatar verrät vor dem Reveal, wem ein Song gehört.

## Tonfall

Du-Form, kurz, frech, nie gemein. Buttons sind Ausrufe, Hinweise sind trocken. Fehlertexte bleiben sachlich und sagen, was zu tun ist.

| Stelle               | So                            | Nicht so                            |
| -------------------- | ----------------------------- | ----------------------------------- |
| Primär-Button Voting | "Setzen!"                     | "Ranking absenden"                  |
| Spin-Button          | "Drehen!"                     | "Genre bestimmen"                   |
| Genre-Kicker         | "Das Rad hat gesprochen"      | "Ausgewähltes Genre:"               |
| Rundensieger         | "JACKPOT! +2 für Mia"         | "Mia gewinnt die Runde."            |
| Gleiche videoId      | "Spiritually Linked!"         | "Duplikat erkannt"                  |
| Fehler Link          | "Kein gültiger YouTube-Link." | "Ups! Da ist was schiefgelaufen 😅" |

Kein Emoji in der UI. Englisch analog (gleicher Witz, nicht wörtlich übersetzt). Alle Texte über i18n, nie hart im Code.

## Farbe

- Grund ist immer `felt-950` (roter Filz `#240a0d`, ruhige Flächen `felt-900` `#3d1016`; Owner-Entscheid 2026-10-16, kein Grün als Fläche), darüber der Backdrop-Wirbel aus `swirl-wine`, `swirl-red`, `swirl-blue`. Die drei Wirbelfarben nie für Inhalt oder Text benutzen.
- Lesbare Flächen sind `panel` (Anthrazit `#1d1f24`, Mulden `well` `#121317`, Kante `edge` `#0a0a0c`) mit Text `cream`, Nebentext `cream-muted`. Werte in Mulden (`well`) sind `gold`.
- **Gold** = Primäraktion, Summe, Gewinner, Fokus. Pro Bereich ein Gold-Button.
- **Blau** = Stimmen und Sekundäraktionen. **Rot** = Bonus, Genre und Genre-Fail. Diese Zuordnung gilt überall gleich (Chips, Combo, Buttons).
- **Grün** = Rang hoch, bereit, Sound an. `red-text` = Minuspunkte, Fehler, Zeit knapp. Status nie nur über Farbe: Pfeil, Wort oder Zahl kommt immer dazu.
- Text auf farbigen Flächen: auf `gold`, `red` und `green` ist kleiner Text `card-ink`. `cream` auf `red` nur ab Display-Größe (`genre`, `score`).
- Karten sind `card-face` mit `card-ink`, Eckziffern `card-red`, Nebentext `card-muted`.

Kontraste (geprüft): `cream`/`panel` 15.3:1, `cream-muted`/`panel` 9.0:1, `gold`/`panel` 9.1:1, `card-ink`/`gold` 9.2:1, `card-ink`/`red` 4.8:1, `cream`/`blue` 4.7:1, `red-text`/`panel` 5.9:1, `cream`/`red` 3.2:1 (nur Display).

## Typografie

- **Jersey 10** (`--font-pixel`) für Schriftzug, Genre, Zahlen, Buttons, Namen. Es gibt nur einen Schnitt: nie `font-weight: 700` setzen (`font-synthesis: none` ist in `.br-stage` gesetzt).
- **Silkscreen** (`--font-label`) für kleine Etiketten in Großbuchstaben (`label`), nur in 16px oder 24px.
- **System-Sans** (`--font-text`) für Erklärtexte, Einstellungen, Fehlermeldungen, Datenschutzhinweis (`body`, `small`).
- Stile: `logo` 64px, `genre` 52px, `score` 44px, `title` 30px, `button` 26px, `body-pixel` 22px, `label` 16px, `body` 15px, `small` 13px.
- Zahlen in Timern und Punkten mit `font-variant-numeric: tabular-nums`, damit nichts springt.
- Schriftzug "BANGER ROULETTE": Stil `logo`, `cream`, Textschatten `0 4px 0 var(--red), 0 8px 0 var(--edge)`. Es gibt kein Logo-Bild, der Schriftzug ist das Logo.

## Form

- Abstände aus `space-1` bis `space-12`, im Spiel meist `space-3` (Gaps) und `space-4` (Panel-Innenabstand).
- Radien: `radius-md` für Panels, Buttons, Karten und Felder, `radius-sm` für Zeilen und Badges, `radius-round` für Chips und Rad.
- Karten 124 × 172px, auf der Hand um 24px überlappend und um -6deg bis 9deg gedreht.
- Der Fokusring ist überall gleich: `outline: 3px solid var(--focus)` mit `outline-offset: 3px`. Keine eigenen Ringe pro Komponente.

## Motion

Bewegung ist das Herz des Systems. Dauern und Kurven sind Tokens (`dur-*`, `ease-*`). In der App mit Motion 14: Dauer in Sekunden, Kurven als Array, z.B. `ease-spring` = `[0.3, 1.6, 0.5, 1]`.

| Animation          | Auslöser                       | Dauer · Kurve                | Komponente        |
| ------------------ | ------------------------------ | ---------------------------- | ----------------- |
| Wirbel             | immer                          | `dur-swirl` · linear         | Backdrop          |
| Wirbel-Hype        | Spin, Jackpot                  | Tempo 5 bis 10 · dann zurück | Backdrop          |
| Karten-Wackeln     | Karte liegt auf der Hand       | `dur-wobble` · `ease-wobble` | SongCard          |
| Anheben            | Hover, Fokus                   | `dur-quick` · `ease-spring`  | SongCard, Button  |
| Einsinken          | Klick                          | `dur-press` · linear         | Button            |
| Kartenflip         | Song wird gespielt             | `dur-reveal` · `ease-spring` | SongCard          |
| Roulette-Spin      | Host startet Runde             | `dur-spin` · `ease-wheel`    | RouletteWheel     |
| Zeiger-Tick        | Segmentwechsel                 | 140ms · `ease-out`           | RouletteWheel     |
| Shake              | Rad stoppt, Jackpot            | 420ms · `steps(6, end)`      | alle              |
| Pop-in             | Genre, Badge, Banner erscheint | `dur-pop` · `ease-spring`    | GenrePlate, Badge |
| Hochzählen + Bump  | Punkte im Reveal               | `dur-count` · Bump `dur-pop` | ScoreCombo        |
| Platztausch        | Zwischenstand                  | `dur-reveal` · `ease-spring` | Leaderboard       |
| Owner-Stempel      | Reveal                         | `dur-pop` · `ease-spring`    | SongCard          |
| Spiritually Linked | Ende der Einreichphase         | 1400ms + Banner              | SpiritLinked      |
| Jackpot            | Rundensieger                   | `dur-jackpot`                | Jackpot           |
| Timer-Tick         | ≤10 s Restzeit                 | 1s · `ease-pixel`            | Stat              |

**Synchron:** Spin, Linked-Animation und Jackpot starten auf allen Clients zur selben Serverzeit und laufen ohne Zufall im Client, damit alle dasselbe sehen (FR-10, AK-1). Zufällige Werte (Rad-Jitter) kommen vom Host.

**Reduced motion** (`prefers-reduced-motion: reduce`, im Repo über `usePrefersReducedMotion`): Wirbel, Wackeln, Shake, Blinken, Ticken und Chip-Regen fallen weg. Alles, was einen Zustand ändert (Genre, Punkte, Owner, Platz), passiert trotzdem, als kurzes Einblenden oder sofort. Der Block steht am Ende von `components.css`.

## Ikonografie

Kein Icon-Set. Symbole sind Pixel-Formen aus CSS (Dreieck für Rang hoch/runter, Quadrat-Punkt in Badges, Zeiger am Rad) oder Zeichen aus Jersey 10 (`#3`, `+`, `=`, `!`). Kein Emoji, keine fremden Logos. YouTube-Thumbnails sind das einzige Bildmaterial.

## Umsetzung im Repo

- Tokens 1:1 in `src/ui/styles.css` unter `@theme` übernehmen (`--color-felt-950` usw.), die `br-*` Klassen aus `components.css` als `@utility` oder Komponenten-Styles.
- Schriften als woff2 aus `fonts/` nach `public/fonts/` legen (zusammen ca. 23 KB). Die CSP (`font-src` über `default-src 'self'`) muss dafür nicht geändert werden.
- Die alten Casino-Tokens (`felt-*`, `ink-*`, `gold-*`, `neon-*`) und `Chip.tsx` werden ersetzt. SPEC.md Abschnitt 6 vorher auf "Pixel-Filz" anpassen, weil die Spec laut AGENTS.md Vorrang hat.
