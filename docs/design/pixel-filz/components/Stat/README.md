# Stat

Eingelassene Mulde mit Silkscreen-Label und großer Goldzahl für Timer, Fertig-Zähler und Runde.

**Markup:** `div.br-stat > span.br-label + span.br-stat__value`. Timer: `role="timer"`, bei ≤10s `.is-urgent` (Zahl `red-text`, tickt pro Sekunde).

**Consumer liefert:** Wert als Text (`0:42`, `3/5`). Timer rechnet clientseitig gegen `deadlineAt`, nie per Netz-Tick (NFR-02).

**Reduced motion:** kein Ticken, Farbe wechselt trotzdem.
