# Jackpot

Die Rundensieger-Show: "JACKPOT!" knallt rein und blinkt, Chips regnen, der Wirbel dreht durch, der Screen wackelt (FR-60).

**Ablauf (gesamt `dur-jackpot`):**

1. 0ms: Gewinner-Karte bekommt `.is-winner`, Owner-Stempel (`br-card__owner`).
2. 0ms: `.br-shake` auf den Screen, Backdrop `.is-hype` + Wirbel auf Tempo 10.
3. 0–700ms: `.br-jackpot__word` mit `br-jackpot-in`, danach 5× `br-blink-gold`.
4. 0–1800ms: 26 Chips in `.br-rain` fallen (`br-fall`, versetzte `--delay`, `--fall`, `--drift`, `--spin`).
5. 500ms: Untertitel (`+2 für <Name>`) faded hoch.
6. 2400ms: alles aufräumen, Wirbel zurück auf Tempo 1.

**Consumer liefert:** Gewinnername(n) (bei Gleichstand alle, FR-51), Container mit `position: relative`, `.br-overlay` mit `hidden` steuern.

**Regeln:** nur einmal pro Runde, nur im Reveal. Kein Jackpot, wenn der Song per Genre-Fail ausgeschlossen ist.

**Reduced motion:** kein Regen, kein Shake, kein Wirbel; Wort blendet ein, Goldrand bleibt.
