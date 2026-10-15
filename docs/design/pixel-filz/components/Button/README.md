# Button

Dicker Pixel-Button, der beim Hover kippt und beim Klick 5px in seine farbige Kante sinkt.

**Klassen:** `.br-btn` (Gold, Primär), `--blue` (Sekundär), `--red` (Genre-Fail, destruktiv), `--slate` (Abbrechen, Tertiär), `--sm` (klein, Feinjustierung ±1 s/±5 s). Toggle-Zustand: `.is-on` + `aria-pressed="true"`.

**Consumer liefert:** Text (kurz, mit Ausrufezeichen erlaubt), `type`, `onClick`, ggf. `disabled`.

**Regeln:**

- Pro Bereich genau ein Gold-Button.
- Texte auf `red` sind `card-ink` (4.8:1), auf `blue` und `slate` `cream`.
- Deaktiviert: `panel`-Fläche mit `ink-disabled`, bekommt keinen Hover.
- Mindesthöhe 44px (36px bei `--sm`).

**Motion:** Hover `dur-quick` + `ease-spring` (translateY -2px, rotate -1deg). Active `dur-press`, Kante auf 0. Motion 14: `whileHover={{ y: -2, rotate: -1 }}`, `whileTap={{ y: 5 }}`, `transition={{ duration: 0.15, ease: [0.3, 1.6, 0.5, 1] }}`.
