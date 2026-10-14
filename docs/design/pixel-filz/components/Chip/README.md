# Chip

Pokerchip aus Streifen-Rand und Innenscheibe, als Deko und als Punkte-Stapel.

**Klassen:** `.br-chip` (rot), `--blue`, `--gold`, `--lg` (48px). Reihe `.br-chips`, Stapel `.br-chipstack`. Fallen lassen: `.is-drop` mit gestaffeltem `animation-delay` (110ms pro Chip).

**Consumer liefert:** `aria-hidden="true"` wenn rein dekorativ, sonst `role="img"` + `aria-label` ("5 Punkte").

**Farbsinn:** blau = Stimmen, rot = Bonus/Jackpot, gold = Gewinn. Gleiche Zuordnung wie in `ScoreCombo`.
