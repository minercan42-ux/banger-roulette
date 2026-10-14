# Badge

Kurzes Silkscreen-Etikett für Status neben einem Spielernamen: Host, Sound an/aus, Zuschauer, Strafe.

**Klassen:** `.br-badge` (slate, neutral), `--gold` (Host), `--green` (Sound an, Fertig), `--red` (Strafpunkte), `--ghost` (Zuschauer). Punkt davor: `span.br-badge__dot` (nimmt die Textfarbe).

**Consumer liefert:** ein bis drei Wörter. Status nie nur über Farbe: Wort immer dabei.

**Motion:** Neu erscheinend `.is-new` = Pop-in (`dur-pop`, `ease-spring`).
