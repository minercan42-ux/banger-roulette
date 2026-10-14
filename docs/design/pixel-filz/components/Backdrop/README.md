# Backdrop

Der wirbelnde Filz-Hintergrund mit Röhrenmonitor-Linien und Vignette, einmal pro Screen hinter allem.

**Markup:** `<div class="br-backdrop"><div class="br-backdrop__swirl"></div>…Inhalt…</div>`. Der Wirbel ist ein echtes Kind-Element (kein Pseudo-Element), damit sich seine Animation per JS beschleunigen lässt.

**Consumer liefert:** Höhe (meist `100dvh`) und den Inhalt. Inhalt liegt automatisch über dem Wirbel und unter den Scanlines.

**Hype-Modus:** `.is-hype` auf `.br-backdrop` macht den Wirbel kräftiger. Für Tempo die Animation selbst umstellen: `swirl.getAnimations()[0].updatePlaybackRate(8)` und nach `dur-jackpot` wieder auf `1`. Nie die `animation-duration` ändern, das springt.

**Wann:** Lobby, Spin, Reveal, Finale. In Playback und Voting bleibt der Wirbel bei Tempo 1, damit er nicht von Karten und Video ablenkt.

**Nicht:** Text direkt auf den Wirbel setzen, der kleiner als 24px ist. Kleiner Text gehört auf `panel`.

**Reduced motion:** Wirbel steht still, Farben bleiben.
