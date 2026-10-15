# Motion

Übersicht aller Mikro-Animationen zum Antippen, damit man das Timing direkt sieht.

| Name      | Klasse / Keyframe      | Dauer        | Kurve           | Wofür                                       |
| --------- | ---------------------- | ------------ | --------------- | ------------------------------------------- |
| pop-in    | `br-pop-in`            | `dur-pop`    | `ease-spring`   | Etwas Neues erscheint: Genre, Badge, Banner |
| bump      | `.br-bump`             | `dur-pop`    | `ease-spring`   | Eine Zahl ändert sich                       |
| shake     | `.br-shake`            | 420ms        | `steps(6, end)` | Rad stoppt, Jackpot, harter Treffer         |
| tick      | `br-tick`              | 1s           | `ease-pixel`    | Timer unter 10 s                            |
| blink     | `.br-blink`            | 1s           | `ease-pixel`    | Glühbirnen, Highscore                       |
| chip-drop | `.br-chip.is-drop`     | `dur-pop`    | `ease-spring`   | Punkte-Chips landen                         |
| wobble    | `.br-wobble`           | `dur-wobble` | `ease-wobble`   | Karten im Leerlauf                          |
| lift      | Hover auf Karte/Button | `dur-quick`  | `ease-spring`   | Anfassbar                                   |

**Regel:** Bewegung erzählt immer ein Spielereignis. Keine Dauerschleifen außer Wirbel, Wackeln und Glühbirnen.
