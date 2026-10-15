# SpiritLinked

Zwei Karten mit derselben videoId fliegen aufeinander zu, eine goldene Kette verbindet sie, dann stempelt "Spiritually Linked!" drauf (FR-26, AK-2).

**Markup:** `div.br-linked[role=status]` mit zwei `.br-card.is-flipped.br-linked__card--a/--b`, `.br-linked__chain` und `.br-linked__banner`. Im Reveal zusätzlich `.br-linked__names` mit den Namen.

**Consumer liefert:** den gemeinsamen Song (Karte), bei aktiver Anonymität keine Namen (AK-3), im Reveal die Namen aller Owner.

**Timing:** Karten 0–1400ms (`ease-out`), Kette 560–1190ms, Banner ab 1200ms (`dur-pop`, `ease-spring`), Namen ab 1500ms.

**Reduced motion:** Karten liegen gleich nebeneinander, Banner und Namen blenden ein, keine Kette.
