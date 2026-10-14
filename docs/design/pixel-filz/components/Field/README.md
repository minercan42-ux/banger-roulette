# Field

Eingabe in einer Mulde mit Silkscreen-Label, Hinweis darunter und kurzem Wackler bei Fehlern.

**Markup:** `label.br-field > span.br-field__label + input.br-field__input + span.br-field__hint`. Fehler: `.is-error` am Feld, `aria-invalid="true"` und `aria-describedby` auf den Hinweis.

**Consumer liefert:** Label, Wert, Hinweis oder Fehlertext (aus i18n).

**Regeln:** Rahmen `cream-muted` (3:1 und mehr gegen `panel`), Fokus `gold`, Fehler `red-text`. Hinweistext ist System-Sans (`small`), weil er oft länger ist.

**Motion:** Fehler schüttelt das Feld einmal (`br-shake-x`, 320ms). Reduced motion: kein Schütteln, nur Farbe.
