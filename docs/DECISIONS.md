# Entscheidungslog

Warum Dinge so sind, wie sie sind. Hier steht der Grund hinter einer Entscheidung, nicht die Umsetzung (die steht im verlinkten Issue oder PR).

**Abgrenzung zu anderen Dokumenten:**

- `SPEC.md` und `PRODUCT.md` sagen, _was_ gilt.
- `docs/ADR-*.md` begründen Architekturentscheidungen.
- `docs/OPEN_QUESTIONS.md` hält technische Defaults und Belege fest, die Agents selbst gewählt haben (AGENTS.md Regel 5).
- Dieses Log hält Entscheidungen des Owners und Entscheidungen des PM in seinem Auftrag fest.

**Wie Einträge entstehen:**

- Der PM ergänzt einen Eintrag, sobald der Owner etwas entscheidet oder der PM für ihn entscheidet. Das passiert im selben PR oder in einem kleinen Docs-PR (siehe `docs/WORKFLOW.md`).
- Einträge werden nie gelöscht. Überholte Einträge bekommen `Status: ersetzt durch D-xxx`.

**Felder:**

- **Wer:** `Owner` heißt, der Owner hat entschieden. `PM` heißt, der PM hat entschieden, und der Owner kann widersprechen.
- **Verworfen:** nennt Alternativen nur, wenn sie ernsthaft auf dem Tisch lagen.

---

## Arbeitsweise

### D-001 Owner als Stakeholder, PM orchestriert und mergt

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Der Owner gibt Richtung, Design und Prioritäten vor und spielt Playtests. Die Hauptsession arbeitet als PM: Sie schreibt Issues, startet Subagents für Umsetzung und Review und mergt selbst, sobald das Merge-Gate erfüllt ist.
- **Warum:** Der Owner will Ergebnisse sehen, statt jeden PR einzeln freizugeben. Seine Zeit soll ins Spielen und Entscheiden fließen, nicht in Code-Reviews.
- **Belege:** `docs/WORKFLOW.md` (PR #112), AGENTS.md Regel 1

### D-002 Höchstens drei Agents gleichzeitig

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Implementer und Reviewer zusammen dürfen höchstens drei sein.
- **Warum:** Alles läuft auf einem kleinen MiniPC (anfangs 2, später 3 vCPU). Die schweren lokalen Prüfungen teilen sich dort einen Lock, und mehr parallele Agents würden sich gegenseitig ausbremsen. Außerdem hält die Grenze die Modellkosten im Rahmen.
- **Belege:** `docs/WORKFLOW.md`

### D-003 Stuck-Check pro Agent und Modell-Leiter

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Jeder Agent bekommt einen eigenen Stunden-Timer. Nach jeder vollen Stunde Laufzeit prüft der PM genau diesen Agent. Hängt er fest, übernimmt ein stärkeres Modell (DeepSeek, dann Sonnet, dann GPT).
  - (Owner, 2026-10-18): nicht-visuelle Arbeit zuerst an DeepSeek, Claude nur als Fallback; visuelle Arbeit bleibt nach D-004 bei Claude.
- **Warum:** Ein Agent hing drei Stunden an den Cross-Browser-Tests, ohne dass es auffiel. Der Timer gilt pro Agent und nicht als globale Stundenrunde, weil Agents zu unterschiedlichen Zeiten starten (Präzisierung des Owners).
- **Belege:** `docs/WORKFLOW.md`

### D-004 Visuelle Arbeit nie mit DeepSeek

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** UI-Umsetzung und visuelle Bewertung laufen auf Sonnet oder GPT. DeepSeek macht nur nicht-visuelle Arbeit wie Rebases, CI und Logik.
- **Warum:** Beim Design zählt das Urteil des Modells, und das günstigste Modell lieferte dort zu wenig Qualität.
- **Belege:** Agent-Definitionen in `~/.omp/agent/agents/`, `docs/WORKFLOW.md`

### D-005 Kein bezahlter Ersatz bei OpenRouter-Limit

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** OpenRouter wird nur für DeepSeek genutzt. Ist das Limit erreicht, sagt der PM Bescheid und übergibt die Arbeit an die Abo-Modelle. Er weicht nie auf ein anderes bezahltes Modell aus.
- **Warum:** Die Kosten sollen planbar bleiben. Die Abos sind schon bezahlt.

### D-006 Schlanke Tests statt maximaler Absicherung

- **Datum:** 2026-10-15
- **Wer:** PM, auf Wunsch des Owners
- **Entscheidung:** Lokal laufen lint, typecheck, unit, build, size und i18n plus nur die geänderten E2E-Specs. Die volle E2E-Suite läuft nur in der CI. Reviews blockieren nur bei echten Bugs, Sicherheitsproblemen, Anonymitätslecks oder nicht erfüllten Akzeptanzkriterien. Tests für Tests werden nicht gefordert, Minors blockieren nicht.
- **Warum:** Der Owner fand die Entwicklung viel zu langsam ("wir haben nicht mal ein funktionierendes Spiel"). Die Zeit ging nicht in den Testlauf selbst, sondern in Review-Runden, die immer neue Beweise verlangten, und in Rebase-Schleifen.
- **Verworfen:** Tests streichen oder zusammenlegen. Die Tests sichern die Multiplayer-Synchronisation ab, und zusammengelegte Tests hätten nur Sekunden gespart.
- **Belege:** `docs/WORKFLOW.md`

### D-007 E2E in der CI auf sechs Shards verteilt

- **Datum:** 2026-10-15
- **Wer:** PM
- **Entscheidung:** Die Chromium-E2E-Suite läuft in sechs parallelen Jobs.
- **Warum:** Ein PR-Lauf dauerte rund 12 Minuten, jetzt rund 5. Mit drei Shards waren die Jobs sehr ungleich verteilt, deshalb sind es sechs.
- **Belege:** #58, PR #59

### D-008 Kein eigener Runner auf dem PC des Owners

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Die CI läuft weiter auf GitHub-Runnern.
- **Warum:** Der Owner will keinen CI-Runner auf seinem PC betreiben.
- **Verworfen:** Self-hosted Runner, obwohl er schneller und für ein privates Repo günstiger gewesen wäre.

### D-009 Repo öffentlich

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Das Repo ist öffentlich.
- **Warum:**
  - Für das private Repo waren die kostenlosen GitHub-Actions-Minuten aufgebraucht, und die CI startete keine Jobs mehr. Öffentliche Repos haben unbegrenzte Actions.
  - Ein Sicherheitsaudit fand keine Secrets. Der Supabase-Key ist ohnehin öffentlich.
  - Die private E-Mail in alten Commits nimmt der Owner hin. Neue Commits laufen über die Noreply-Adresse, und GitHub blockiert jetzt Pushes mit der privaten Adresse.
- **Verworfen:** Spending-Limit erhöhen (laufende Kosten). Bis zum Monatswechsel warten (bis dahin keine CI).

### D-010 Firefox und WebKit nur nachts und auf Knopfdruck

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Die Cross-Browser-E2E laufen nicht mehr bei jedem Push auf main.
- **Warum:** Sie kosteten pro main-Push rund 2 x 16 Runner-Minuten. Fehler fallen jetzt spätestens am nächsten Morgen auf.
- **Belege:** #77, PR #79

### D-011 Live-Smoke nur manuell

- **Datum:** 2026-10-15
- **Wer:** PM
- **Entscheidung:** Der Live-Smoke gegen Produktion startet nicht automatisch nach einem Deploy, sondern nur auf Knopfdruck oder vom Host aus.
- **Warum:**
  - YouTube blockiert die Wiedergabe von GitHub-Runner-IPs mit einem Bot-Check (Fehler 150, LOGIN_REQUIRED). Ein automatischer Lauf wäre dauerhaft rot und würde echte Fehler verdecken.
  - Der Trigger hatte außerdem die SSO-geschützte Vercel-URL getroffen.
- **Belege:** #51, PR #54

### D-012 Strenge CSP behalten, zod im jitless-Modus

- **Datum:** 2026-10-15
- **Wer:** PM
- **Entscheidung:** Zod läuft jitless. Die CSP wird nicht gelockert.
- **Warum:** Zods Eval-Probe löste unter der Produktions-CSP Verstöße aus. Den Code zu ändern ist sicherer, als `unsafe-eval` zu erlauben.
- **Belege:** #43, PR #48

### D-013 Playtest-Bots außerhalb des Repos, standardmäßig schnell

- **Datum:** 2026-10-15 bis 2026-10-17
- **Wer:** Owner, PM
- **Entscheidung:** `../playtest/bots.mjs` liegt außerhalb des Repos. Die Bots beginnen das Einreichen nach höchstens 2 Sekunden Wartezeit (danach folgen noch Vorschau und Speichern). Das langsamere, realistischere Verhalten gibt es mit `--slow`.
- **Warum:** Der Owner braucht Mitspieler zum Testen, ohne Freunde einzuladen. Die Bots sind ein Werkzeug und kein Produktbestandteil. Bot 1 ließ sich zu viel Zeit, und das bremste die Testrunden.

### D-014 Label `playtest`

- **Datum:** 2026-10-17
- **Wer:** Owner
- **Entscheidung:** Issues aus Playtests bekommen das Label `playtest`. "Arbeite an allen Playtest-Issues" heißt: alle offenen Issues mit diesem Label abarbeiten.
- **Warum:** Playtest-Funde sollen gesammelt und in einem Rutsch bearbeitet werden, nicht verstreut.

### D-015 Design-Skills und PRODUCT.md

- **Datum:** 2026-10-17
- **Wer:** Owner
- **Entscheidung:**
  - Die Skills `frontend-design` und `impeccable` sind installiert. UI-Agents nutzen sie, und Reviewer bewerten visuelle PRs zusätzlich danach.
  - `impeccable init` hat `PRODUCT.md` angelegt.
  - Eine `DESIGN.md` gibt es nicht.
- **Warum:**
  - Die Agents sollen gestalterisch besser arbeiten, nicht nur korrekt.
  - `PRODUCT.md` gibt ihnen Kontext: wer spielt, worum es geht, was bindend ist.
  - Eine `DESIGN.md` hätte neben `docs/design/pixel-filz/` eine zweite Quelle für das Design-System geschaffen.
- **Belege:** #103, PR #104

### D-016 Desktop first bleibt

- **Datum:** 2026-10-17
- **Wer:** Owner
- **Entscheidung:** Der Desktop-Browser ist das Hauptziel. Bis 360 px Breite bleibt alles spielbar.
- **Warum:** Gespielt wird meist am Rechner neben einem Call. Das Handy soll funktionieren, gibt aber nicht die Gestaltung vor.
- **Belege:** PR #105, SPEC.md Abschnitt 2

### D-017 Stuck-Check per Hook erzwungen

- **Datum:** 2026-10-18
- **Wer:** Owner
- **Entscheidung:** Der stündliche Stuck-Check pro Agent wird per omp-Hook ausgelöst statt vom Gedächtnis des PM.
- **Warum:** Ein Agent lief am 2026-10-18 drei Stunden, ohne dass der PM stündlich nachsah.
- **Verworfen:** Nur eine Regel in AGENTS.md (rutscht wieder durch).
- **Belege:** `~/.omp/agent/hooks/post/br-stuck-check.ts`, `docs/WORKFLOW.md`

## Spiel und Design

### D-020 Pixel-Filz-Redesign umsetzen

- **Datum:** 2026-10-15
- **Wer:** Owner
- **Entscheidung:** Der Plan #45 wurde in zehn Task-Issues zerlegt und umgesetzt. Die Issues #22 bis #26 sind als ersetzt geschlossen.
- **Warum:** Dem Owner gefiel der Gold/Neon-Look aus #39 nicht.
- **Belege:** #45, PR #46, #61 bis #71, PRs #72 bis #84

### D-021 Spin-Dauer: erst gekürzt, dann verlängert

- **Datum:** 2026-10-15, ersetzt 2026-10-16
- **Wer:** Owner
- **Status:** ersetzt durch D-028
- **Entscheidung:** Das Design-Token für die Spin-Dauer wurde auf 2580 ms gekürzt, die Engine blieb bei 3000 ms.
- **Warum:** Eine Engine-Änderung war damals nicht nötig, um das Design einzupassen.
- **Belege:** #61, PR #72

### D-022 Spieltisch statt Mittelspalte, roter Filz statt Grün

- **Datum:** 2026-10-16
- **Wer:** Owner
- **Entscheidung:**
  - Das Layout ist ein Tisch über die volle Breite: Topleiste, Spieler seitlich, Bühne, Aktionsleiste.
  - Der Tisch ist dunkelroter Filz, die Panels sind anthrazit, Grün gibt es keins mehr.
- **Warum:**
  - Nach Pixel-Filz war die App "ein Balken in der Mitte" ohne Horizontalität: Alles hing an einer einzigen 672-px-Spalte.
  - Das Grün der Panels gefiel nicht.
- **Verworfen:** Bühne mit Seitenleiste ohne Aktionsleiste, Vollbild-Phasen, Anthrazit, Violett.
- **Belege:** #86, PR #88

### D-023 Bewertung 0 bis 10 während der Song läuft, kein Voting mehr

- **Datum:** 2026-10-16
- **Wer:** Owner
- **Entscheidung:**
  - Jeder bewertet fremde Songs per Chip-Leiste von 0 bis 10, während sie laufen, und kann bis zum Ende der Wiedergabe ändern.
  - Die Voting-Phase entfällt.
  - Der Songscore ist der Durchschnitt mit einer Nachkommastelle. Der Rundensieger bekommt +2.
- **Warum:**
  - Das Voting kam oft gar nicht zustande: Mit 3 Spielern und einem Aussetzer gab es weniger als 2 fremde Songs, und die Regel FR-54 übersprang das Voting.
  - Ein bis zwei Songs zu ranken macht keinen Spaß.
  - Im Moment des Hörens zu bewerten ist schneller und ehrlicher.
  - Der Durchschnitt ist fair, auch wenn unterschiedlich viele Spieler bewerten.
- **Verworfen:**
  - Chips verteilen (10 Chips pro Runde frei setzen): Der Owner will ein Rating im Chip-Stil, keine Verteilung.
  - Podium, Duelle, eigene Voting-Phase nach den Songs.
- **Belege:** #85, PR #89

### D-024 Spiritually-Linked-Bonus 5.0 ohne Bewerter

- **Datum:** 2026-10-16
- **Wer:** Owner (Regel), PM (Wert 5.0)
- **Entscheidung:** Haben alle aktiven Spieler denselben Song eingereicht, kann ihn niemand bewerten. Jeder Besitzer bekommt dann 5.0, und der Song kann nicht Rundensieger werden.
- **Warum:** Einigkeit soll belohnt werden, aber nicht mehr bringen als ein gut bewerteter Song. 5.0 ist die Mitte der Skala.
- **Belege:** #85

### D-025 "THIS IS A BANGER" nur bei genau 10.0

- **Datum:** 2026-10-16
- **Wer:** Owner
- **Entscheidung:** Die große Show mit Sound kommt nur, wenn alle Bewerter 10 gegeben haben.
- **Warum:** Weil sie selten ist, wird sie zum Ereignis. Ab 9.5 oder bei jeder einzelnen 10 wäre sie zu häufig und verlöre ihre Wirkung.
- **Belege:** #87, PR #91

### D-026 Eigene Genre-Listen: ein Name genügt

- **Datum:** 2026-10-16
- **Wer:** PM
- **Entscheidung:**
  - Deutscher und englischer Name dürfen gleich sein, und ein Name pro Genre reicht.
  - Ein Duplikat ist nur, wenn zwei Zeilen gleich heißen.
  - Neben dem Speichern-Knopf steht immer der Grund, warum gerade nicht gespeichert werden kann.
- **Warum:** "Techno/Techno" galt als Duplikat, und der Knopf war ohne jede Erklärung ausgegraut. Der Owner konnte seine Liste nicht speichern.
- **Belege:** #93, PR #97

### D-027 Sync-Diagnose nur im Debug-Modus

- **Datum:** 2026-10-16
- **Wer:** PM
- **Entscheidung:** Die Tabelle mit Uhr-Offset, RTT und Drift erscheint nur im Debug-Modus (`?debug=1` in der URL oder localStorage `banger-roulette.debug` = `1`).
- **Warum:** Für Spieler sind das Entwicklerdaten. Tests und Live-Smoke brauchen sie weiterhin.
- **Belege:** #99, PR #102

### D-028 Genre-Walze von der Seite, Ergebnis bleibt stehen

- **Datum:** 2026-10-16
- **Wer:** Owner (Walze, Ergebnis bleibt), PM (5.5 s)
- **Entscheidung:**
  - Statt des flachen Rads gibt es eine Walze wie beim Spielautomaten, auf der die Genres lesbar durchlaufen.
  - Die Spin-Phase dauert jetzt 5.5 s statt 3 s: rund 3.2 s Drehen, mindestens 2 s steht das Ergebnis.
  - Danach bleibt das Genre oben sichtbar.
- **Warum:** Auf dem Rad waren die Genres schlecht lesbar, und das Ergebnis verschwand sofort.
- **Belege:** #94, PR #100

### D-029 Video groß oben, keine YouTube-Steuerung

- **Datum:** 2026-10-16
- **Wer:** Owner
- **Entscheidung:** Das laufende Video steht in 16:9 über die ganze Bühnenbreite ganz oben. Eine transparente Schicht verhindert Hover und Klicks auf den YouTube-Player.
- **Warum:**
  - Das Video war klein, stand unten und hatte ein komisches Format.
  - Beim Hovern erschien die YouTube-Steuerung, und ein Klick konnte einen einzelnen Spieler aus dem Takt bringen.
- **Belege:** #95, PR #98

### D-030 Videoqualität nicht begrenzbar

- **Datum:** 2026-10-17
- **Wer:** PM (technische Grenze)
- **Entscheidung:** Es gibt keine 1080p-Obergrenze.
- **Warum:** YouTube hat die Qualitätswahl für eingebettete Player abgeschaltet: `setPlaybackQuality` wirkt laut offizieller Änderungshistorie nicht mehr. Der einzige Hebel wäre ein kleinerer Player, und das widerspricht D-029.

### D-031 Ein Start-Popup statt Häkchen in jedem Spiel, Zustimmung gespeichert

- **Datum:** 2026-10-16
- **Wer:** Owner
- **Entscheidung:**
  - Ein Popup mit "Los geht's" oder "Ohne Videos" ersetzt die Einwilligungs-Häkchen und den Schritt "Sound aktivieren".
  - Die YouTube-Zustimmung wird im localStorage gespeichert. Nach einem Neuladen reicht ein Tippen, damit der Browser den Ton freigibt.
  - Widerrufen kann man im Menü, und der Widerruf gilt auch für andere offene Tabs.
- **Warum:** Das Häkchen bei jedem Spiel nervte. Das Spiel soll einfach laufen wie nach einem Cookie-Banner.
- **Belege:** #96, PR #101

### D-032 Lautstärke als Icon oben rechts

- **Datum:** 2026-10-17
- **Wer:** Owner
- **Entscheidung:** Ein Lautsprecher-Icon in der Topleiste öffnet einen Regler mit Stummschaltung. Der Regler im Wiedergabe-Panel entfällt.
- **Warum:** Die Lautstärke ist eine globale Einstellung und soll in jeder Phase an derselben Stelle sein.
- **Belege:** #107, PR #113

### D-033 Verlinkung verschiedener Uploads: Strenge vor Trefferquote

- **Datum:** 2026-10-17
- **Wer:** Owner (Ziel, Priorität), PM (Regel)
- **Entscheidung:**
  - Verschiedene Uploads desselben Songs werden nur verknüpft, wenn alles passt: Länge, Versionsmarker, exakter Songname, exakt gleiche Künstlermenge, beide Kanäle gehören dem Künstler.
  - Fan-, Lyrics- und Karaoke-Kanäle werden nie verknüpft.
  - Ein Song, der wie der Künstler heißt, wird nur bei exakt "Künstler" oder "Künstler - Künstler" verknüpft.
  - (PM, 2026-10-18, #133): Uploads von Kanälen, deren Kanalprüfung ausschließlich wegen lyric/lyrics, 7clouds oder Lyrical Lemon scheitert (also auch "Adele Lyrics"), dürfen verlinkt werden, wenn der Titel Künstler und Track liefert und alle anderen Prüfungen passen (Künstler, Track, Dauer, Versionsmarker); Cover-, Karaoke-, Fan-, Tribute-, Nightcore-, Slowed-, Sped- und 8D-Kanäle bleiben gesperrt. Punktierte Abkürzungen gelten nur gleich, wenn die andere Schreibweise komplett großgeschrieben ist (U.S.A. = USA, R.E.M. = REM, aber P.O.D. ist nicht Pod). Gleiche Video-IDs landen immer in einer Gruppe.
- **Warum:**
  - Der Owner hat ausdrücklich verlangt, dass verschiedene Songs nie als derselbe gelten.
  - Ein falsch verknüpfter Song zerstört eine Runde. Eine übersehene Dublette führt nur dazu, dass zwei Uploads getrennt bewertet werden.
  - Jede Review-Runde fand neue Grenzfälle, deshalb gilt jetzt eine allgemeine Regel statt Einzelfixes.
  - (PM, 2026-10-18, #133): Playtest 2026-10-17, "Party In The USA (Lyrics)" wurde nicht mit dem offiziellen Video verlinkt; Lyrics-Videos tragen fast immer die Originalaufnahme.
- **Verworfen:**
  - Unscharfer Titelvergleich mit Schwellwert: "Shape of You" wäre "Shape of Water" geworden.
  - Künstler-Jaccard ab 0.5: "Pink" wäre "Pink Floyd" geworden.
- **Belege:** #106, PR #114, #115, PR #116, [PR #138](https://github.com/minercan42-ux/banger-roulette/pull/138), `docs/OPEN_QUESTIONS.md`

### D-040 Nur noch "Fertig", Vorschau startet automatisch

- **Datum:** 2026-10-17
- **Wer:** Owner
- **Entscheidung:**
  - "Einreichung speichern" entfällt. "Fertig" reicht den Song ein und wartet auf die Bestätigung des Hosts.
  - Die Vorschau startet etwa 1 s nach dem Einfügen eines gültigen Links von selbst.
  - (Owner) Der bestätigte Link wird im Hintergrund automatisch eingereicht, sobald die Vorschau läuft; ein Song zählt also auch ohne "Fertig" zum Ablauf der Zeit (Owner-Entscheidung 2026-10-17).
  - (PM) Startpunkt-Änderungen werden nach 1 s nachgespeichert.
  - (PM) Der Button "Vorschau abspielen" erscheint nur noch, wenn der Browser Autoplay blockiert.
  - (PM) "Fertig" nach einem Neuladen ohne YouTube-Zustimmung schließt ab, wenn der Host genau diesen Link mit diesem Startpunkt schon hat (keine Anfrage an YouTube nötig); ohne gespeicherten Song bleibt der Zustimmungs-Hinweis.
  - (PM) Ein abgelehntes Einreichen beendet den Klick mit Fehlermeldung, ohne stillen zweiten Versuch und ohne "fertig".
- **Warum:** Wer den Link einfügt und sofort auf "Fertig" drückt, bekam eine Bestätigung, aber sein Song fehlte. In echten Spielen passiert das oft. Ein eigener Klick auf "Vorschau" ist unnötig.
- **Belege:** #108, [PR #121](https://github.com/minercan42-ux/banger-roulette/pull/121)

### D-041 Genre-Fail als Chip statt der 0

- **Datum:** 2026-10-17
- **Wer:** Owner (Chip mit Symbol), PM (zählt als 0)
- **Entscheidung:**
  - Der eigene Genre-Fail-Button entfällt, ein Symbol-Chip ersetzt die 0. Er setzt das Genre-Fail-Flag und zählt zugleich als Bewertung 0.
  - (PM) Der Genre-Fail-Chip ist der Bewertungswert 0; das eigene Event SET_GENRE_FAIL und das Feld genreFailFlags entfallen; das Flag ist bis zum Ende der Wiedergabe änderbar, eine Zahl hebt es auf.
- **Warum:**
  - Ein Knopf weniger.
  - Wer "passt nicht zum Genre" sagt, gibt dem Song inhaltlich keine Punkte. So bleibt die Bedeutung des alten 0-Chips erhalten.
- **Belege:** #109, [PR #120](https://github.com/minercan42-ux/banger-roulette/pull/120)

### D-042 Skip-Abstimmung ab 90 %

- **Datum:** 2026-10-17
- **Wer:** Owner (Skip, 90 %), PM (Details)
- **Entscheidung:**
  - Wer bewertet hat, kann für Skip stimmen. Besitzer des Songs dürfen auch ohne Bewertung.
  - Ab 90 % der aktiven Spieler geht es für alle synchron zum nächsten Song.
  - (PM) Schwelle ceil(9n/10) über die verbundenen Teilnehmer der Runde: bei 3 bis 9 Spielern müssen alle zustimmen, bei 10 Spielern 9. Getrennte Spieler zählen nicht (ihre Stimme zählt nach dem Wiederverbinden wieder). Nicht-Owner erst nach ihrer Bewertung (auch Genre-Fail), Owner jederzeit; Stimme zurücknehmbar. Netzwerkevent SKIP_VOTE.
- **Warum:** Man muss nicht jeden Clip voll hören. Die Hürde von 90 % und die vorherige Bewertung verhindern, dass ein Song weggeskippt wird, bevor alle ihn gehört und bewertet haben.
- **Belege:** #110, [PR #122](https://github.com/minercan42-ux/banger-roulette/pull/122)

### D-043 Lautstärke startet bei 20 % und wird gespeichert, ohne Cookies

- **Datum:** 2026-10-17
- **Wer:** Owner (20 %, merken), PM (localStorage)
- **Entscheidung:**
  - Die Lautstärke startet bei 20 %. Lautstärke und Stummschaltung werden im localStorage gespeichert, nicht in Cookies.
  - (PM) Auch SFX an/aus wird gespeichert (banger-roulette.sfx). Nichts wird geschrieben, bevor der Nutzer eine Einstellung ändert. Gespeichert werden nur Präferenzen, kein Tracking, keine Cookies.
- **Warum:**
  - YouTube startete zu laut.
  - Cookies würden bei jedem Aufruf an den Server gehen, ohne dass das etwas bringt, und der Datenschutzhinweis verspricht "keine Cookies".
- **Belege:** #111, [PR #119](https://github.com/minercan42-ux/banger-roulette/pull/119)

### D-044 Die Banger-Show läuft einmal pro Runde

- **Datum:** 2026-10-17
- **Wer:** PM (Owner kann widersprechen)
- **Entscheidung:**
  - Die große Banger-Show mit Sound läuft nur beim ersten Banger einer Runde (in Aufdeckreihenfolge).
  - Jeder weitere Banger der Runde behält seinen "THIS IS A BANGER"-Stempel am Eintrag, bekommt aber keine Show, keinen Banger-Sound und den normalen Aufdeck-Slot statt der 5 Sekunden.
  - Die erste Show nennt nur ihren eigenen Song, nichts von späteren Einträgen.
- **Warum:** Im Playtest lief die Show bei mehreren Bangern (genau 10.0, D-025) zwei- oder mehrmals hintereinander. Das nutzte die seltene Show ab und hielt die Runde auf.
- **Belege:** #134

### D-045 Abgebrochenes Fertig nach kurzer Unterbrechung

- **Datum:** 2026-10-18
- **Wer:** PM (Owner kann widersprechen)
- **Entscheidung:** Bricht ein laufendes "Fertig" ab, weil die Schreibberechtigung kurz weg war (Pause, Verbindungsabbruch), zeigt das Panel "Die Verbindung war kurz weg. Bitte noch einmal auf „Fertig“ drücken." und behält den Entwurf; kein automatischer neuer Versuch; die erste Abbruchursache eines Klicks zählt, ein Abbruch durch Widerruf der YouTube-Zustimmung oder eine Link-Änderung bleibt still.
- **Warum:** Ein still verworfenes Fertig ließ Spieler glauben, sie seien fertig (gleicher Ablauf wie das P0 aus #108).
- **Verworfen:** Automatisch erneut senden: könnte nach der Pause einen veralteten Entwurf einreichen.
- **Belege:** #141, [PR #143](https://github.com/minercan42-ux/banger-roulette/pull/143)

### D-046 Spiritually Linked als eigener Moment

- **Datum:** 2026-10-18
- **Wer:** Owner (Moment soll spannend sein, alle Owner bekommen die Punkte, Look abgenommen), PM (Ablauf und Vorrang)
- **Entscheidung:**
  - Beim Reveal fliegen die Karten aller Owner zusammen, es gibt einen Aufprall, die Karten drehen sich um, dann Kette und Banner, jeder Owner erscheint mit seinen Punkten, und die Zeile "+X für A und B" (Owner-Anteil laut Engine, auch bei "halbiert") schließt den Moment ab; alles läuft innerhalb des Reveal-Slots.
  - Im Vorlauf zeigt ein kurzer Teaser bei aktiver Anonymität ohne Namen (AK-3) dasselbe im Videorahmen und nie über Bewertung, Skip oder Pause.
  - Der Moment ist Teil des Eintrags, nie ein zweites Vollbild-Overlay: Trägt der Eintrag die Banger-Show, ruht der Moment im fertigen Zustand und sein Sound entfällt; beim Jackpot läuft die Animation, aber der Sound gehört dem Jackpot.
  - Der laufende Moment scrollt einmal in den sichtbaren Bereich, aber nur ohne fokussiertes Bedienelement und ohne Eingabe in den letzten 2 s.
  - Reduzierte Bewegung zeigt den ruhigen Endzustand.
- **Warum:** Playtest 2026-10-17: die alte Animation war "giga langweilig" und zeigte nicht, dass alle Owner punkten. Reviews fanden, dass der Moment sonst außerhalb des Bildschirms ablief.
- **Verworfen:**
  - Vollbild-Overlay wie die Banger-Show: stört zwei Shows pro Runde.
  - Teaser fest in der Bildschirmmitte: verdeckte Skip.
- **Belege:** #135, [PR #142](https://github.com/minercan42-ux/banger-roulette/pull/142), #146 (360 px)

## Beschlossen, Umsetzung offen

Derzeit nichts offen.
