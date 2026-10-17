# Banger Roulette: Auftrag an den Orchestrator

## 0. Deine Rolle
Du bist Tech Lead und Orchestrator eines Agenten-Teams. Du planst, zerlegst die Arbeit, spawnst spezialisierte Subagents, definierst Schnittstellen, reviewst und integrierst. Selbst schreibst du nur Contracts, ADRs und Integrationscode.
Ziel: ein lauffähiges, getestetes und deploytes MVP von "Banger Roulette" gemäß dieser Spezifikation.

## 1. Produktvision
Browserbasiertes Multiplayer-Partyspiel für 3-10 Spieler, die remote spielen. Pro Runde wird ein Musikgenre bestimmt. Jeder reicht per YouTube-Link den Song ein, den er für den größten Banger dieses Genres hält. Alle hören die Ausschnitte synchron auf ihren eigenen Geräten, bewerten die Songs der anderen live mit 0 bis 10 Punkten und bekommen Punkte. Casino-Flair, schnelle Runden, kein Login.

## 2. Rahmenbedingungen
- Zielgruppe MVP: privater Freundeskreis. Eine spätere öffentliche Version (Phase 2) ist möglich, die Architektur darf sie nicht verbauen.
- Kein Login, keine Accounts, keine Persistenz. Der Spielstand lebt nur in der laufenden Session.
- Kostenrahmen: Free Tiers (Vercel Hobby, Supabase Free).
- UI zweisprachig Deutsch und Englisch (i18n, z.B. i18next). Sprache wird automatisch aus der Browsersprache gewählt, ist jederzeit umschaltbar, Fallback Deutsch. Keine hartcodierten UI-Strings. Code, Kommentare und Commits auf Englisch.
- Desktop-Browser first, responsive bis 360 px Breite. Auf dem Handy spielbar, aber nicht primäres Ziel.

## 2a. Umgebung und Zugänge
- Code liegt im privaten GitHub-Repo `minercan42-ux/banger-roulette`. Du pushst nur Feature-Branches und öffnest Pull Requests. Direkte Pushes auf main sind verboten. Da das Repo privat im Free-Plan liegt, setzt GitHub keine Branch Protection durch: Diese Regel gilt per Vereinbarung und ist nicht technisch erzwungen. Gemergt wird nur mit grüner CI, per Squash-Merge, durch den Nutzer oder nach seiner ausdrücklichen Freigabe.
- CI läuft über GitHub Actions (`.github/workflows/ci.yml`, bereits angelegt). Sie ruft die pnpm-Scripts `lint`, `typecheck`, `test`, `build`, `i18n:check` und `test:e2e` auf. Diese Script-Namen sind verbindlich, M0 muss sie in `package.json` anlegen.
- Arbeitsregeln für alle Agents stehen in `AGENTS.md`.
- Deployment erfolgt über die Git-Integration von Vercel: jeder PR bekommt ein Preview-Deployment, main geht auf Produktion. Du hast keinen Zugriff auf Vercel- oder Supabase-Admin-Konsolen und brauchst ihn auch nicht.
- Env-Variablen (lokal in `.env.local`, nie committet): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Weitere Variablen nur nach Rückfrage.
- Wenn du etwas brauchst, das nur der Nutzer einrichten kann (Account, Key, Setting), stoppe und beschreibe es mit konkretem Klickpfad.

## 3. Architektur
Verbindlich. Abweichungen nur per ADR mit Begründung.

| Bereich | Entscheidung |
|---|---|
| Frontend | Vite + React + TypeScript (strict), Tailwind CSS, Motion (ehem. Framer Motion) für Animationen, Zustand für Client-State |
| Hosting | Vercel: statisches SPA plus wenige Serverless Functions (`/api/time`, ggf. `/api/oembed`) |
| Echtzeit | Supabase Realtime: ein Channel pro Raum (`room:{CODE}`), Broadcast für Events, Presence für die Spielerliste. Keine Tabellen, keine Supabase Auth, kein service_role Key |
| Spiellogik | Host-autoritativ: Der Browser des Hosts führt die Game Engine aus und ist die einzige Quelle der Wahrheit |
| Validierung | zod-Schemas für alle Netzwerkevents, gemeinsam genutzt von Sender und Empfänger |
| Tests | Vitest (Unit), Playwright (E2E mit mehreren Browser-Kontexten) |
| Paketmanager | pnpm |

ADR-001 mit dieser Begründung anlegen: Die nativen WebSockets von Vercel (Beta) bieten keinen Fan-out über Instanzen und keine Presence. Ein Raum mit mehreren Spielern braucht genau das. Supabase Realtime liefert beides ohne eigenen Server.

Architekturregeln:
- `src/engine/`: reine, deterministische TypeScript-Logik, also ein Reducer `(state, action) => state` plus Selektoren. Keine Imports aus net, player oder ui. Zeit- und Zufallsquellen werden injiziert, nie direkt aufgerufen. Per Lint-Regel erzwingen (z.B. eslint-plugin-boundaries). So lässt sich die Engine in Phase 2 unverändert auf einen Server verschieben.
- `src/net/`: Transport-Adapter hinter einem Interface `GameTransport`, mit einer Supabase-Implementierung und einer In-Memory-Implementierung für Tests.
- `src/player/`: Wrapper um die YouTube IFrame Player API.
- `src/ui/`: Komponenten und Screens. Sie lesen nur über Selektoren und senden nur Actions.
- `src/shared/`: Typen und zod-Schemas (Contracts).
- Host-Migration: Der Host broadcastet nach jeder Zustandsänderung einen vollständigen, versionierten State-Snapshot (`stateVersion` steigt monoton). Verlässt der Host den Raum laut Presence, übernimmt deterministisch der am längsten anwesende Spieler mit dem letzten Snapshot.
- Timer werden als absolute Deadlines (`deadlineAt`, normalisiert auf Serverzeit) übertragen, nie als sekündliche Countdown-Nachrichten.

Bekannte, akzeptierte Grenzen des MVP (in `docs/SECURITY.md` dokumentieren): Da alle Clients den vollständigen State erhalten, ist die Anonymität nur UI-seitig umgesetzt und mit DevTools umgehbar. Absender von Broadcasts sind nicht kryptografisch verifiziert. Für den Freundeskreis ist das akzeptiert. Phase 2: Engine serverseitig betreiben (z.B. Cloudflare Durable Objects oder eigener Node-Server), Clients erhalten nur noch gefilterte Views.

## 4. Spielablauf (State Machine)
`LOBBY -> GENRE_SPIN -> SUBMISSION -> PLAYBACK -> REVEAL -> (weitere Runde: GENRE_SPIN | sonst FINAL) -> LOBBY (Rematch)`

Jeder Übergang erfolgt über eine Deadline oder eine Host-Aktion. Jede Phase zeigt den Timer und wer noch fehlt, ohne zu verraten, was gewählt wurde.

## 5. Funktionale Anforderungen

### 5.1 Lobby und Raum
- FR-01 Raum erstellen: Nickname eingeben, dann werden ein Raumcode (6 Zeichen A-Z ohne verwechselbare Zeichen wie O/I) und ein teilbarer Link `/r/{CODE}` erzeugt. Kollisionsprüfung über Presence.
- FR-02 Beitreten per Code oder Link mit Nickname (1-20 Zeichen, getrimmt, eindeutig im Raum).
- FR-03 Live-Spielerliste über Presence, Host ist markiert und kann Spieler kicken.
- FR-04 Reconnect: `clientId` liegt im localStorage. Nach Reload oder Netzabbruch landet der Spieler wieder im Raum, mit seinem Punktestand.
- FR-05 Beitritt während eines laufenden Spiels: zunächst als Zuschauer, ab der nächsten Runde als Mitspieler.
- FR-06 Mindestens 3, maximal 10 Spieler. Fallen während des Spiels weniger als 3 aktive Spieler übrig, pausiert das Spiel mit Hinweis. Der Host kann dann fortsetzen oder beenden.
- FR-07 Audio-Freischaltung: Beim Beitritt ist ein expliziter Klick auf "Sound an" nötig (Autoplay-Policy der Browser). Der Status jedes Spielers ist in der Lobby sichtbar.

### 5.2 Einstellungen (Host, in der Lobby, ähnlich Gartic Phone)

| Einstellung | Werte | Default |
|---|---|---|
| Genre-Modus | Roulette (vordefinierte Liste), Custom-Liste (Host gibt Genres ein, das Rad dreht darüber), Ein Genre (fix für alle Runden) | Roulette |
| Runden | 1-20 | 5 |
| Auswahlzeit | 30-300 s | 90 s |
| Ausschnittlänge | 15-60 s | 40 s |
| Anonymität | an (Zuordnung erst beim Reveal) / aus (Name des Owners beim Abspielen sichtbar) | an |
| Genre-Fail-Strafe | aus oder -1 bis -10 | -3 |
| Linked-Punkte | voll für jeden Owner / halbiert (aufgerundet) | voll |

Die vordefinierte Genre-Liste umfasst mindestens 30 Genres und liegt als `src/content/genres.json` vor, je Genre mit stabiler ID und Bezeichnung auf Deutsch und Englisch. Eine Custom-Liste hat 2-50 Einträge.

### 5.3 Genre-Roulette
- FR-10 Animiertes Genre-Roulette als Walze in Casino-Optik (Slot-Drum, seitlich gesehen: Genrenamen laufen waagerecht, die mittlere Reihe ist das Auswahlfenster, Reihen darüber und darunter sind perspektivisch verkürzt). Der Host bestimmt das Ergebnis per injizierter RNG vor Start der Animation, alle Clients animieren deterministisch auf dasselbe Genre. Die Phase dauert 5,5 s (`SPIN_MS = 5500`): ca. 3,2 s Spin mit Abbremsen, danach bleibt das Ergebnis mindestens 2 s sichtbar (Genre-Plakette, Lichtstreif, goldenes Fenster) und steht anschließend als Genre-Plakette oben in der Einreichungsphase. Mit `prefers-reduced-motion` entfällt der Spin, das Ergebnis steht sofort. Im Modus "Ein Genre" gibt es statt des Spins eine kurze Einblendung.
- FR-11 Kein Genre wird doppelt gezogen, bis die Liste erschöpft ist.

### 5.4 Song-Auswahl
- FR-20 Eingabe eines YouTube-Links. Unterstützt werden `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `music.youtube.com` und `m.youtube.com`, jeweils mit oder ohne weitere Parameter. Die videoId (11 Zeichen) wird extrahiert, ein `t=`-Parameter dient als Vorschlag für den Startpunkt. Andere Domains werden abgelehnt.
- FR-21 Metadaten (Titel, Kanal, Thumbnail) kommen über YouTube oEmbed. Verhindert CORS den direkten Abruf, wird eine Vercel Function `/api/oembed` als Proxy gebaut, die ausschließlich YouTube-URLs akzeptiert.
- FR-22 Embed-Validierung: Vorschau im IFrame Player. Bei Fehlercodes, die "nicht verfügbar" oder "Embedding verboten" bedeuten (laut Doku u.a. 100, 101, 150; aktuelle Liste prüfen), wird die Einreichung mit einer verständlichen Meldung blockiert.
- FR-23 Startpunkt wählen: Vorschau-Player mit Button "Startpunkt setzen" und Feinjustierung um ±1 s und ±5 s. Der Ausschnitt ist `[start, start + Ausschnittlänge]`, begrenzt durch die Videolänge.
- FR-24 Die Einreichung ist bis zum Ablauf der Auswahlzeit oder bis "Fertig" änderbar. Die Phase endet vorzeitig, wenn alle fertig sind.
- FR-25 Wer bis zum Ablauf nichts einreicht, setzt die Runde aus (0 Punkte), darf aber bewerten.
- FR-26 Spiritually Linked: Reichen mehrere Spieler denselben Song ein, ist das kein Fehler. Derselbe Song ist dieselbe videoId oder, bei verschiedenen Uploads, ein Paar, das die host-seitige, deterministische Regel aus #106 erfüllt (Dauer, Versionsmarker, Trackname, Künstler, Kanal-Guard; im Zweifel nicht verknüpft, siehe docs/OPEN_QUESTIONS.md). Der Song wird zu einem Eintrag mit mehreren Ownern und mehreren Mitglieds-Uploads zusammengeführt; die kanonische ID und der Startpunkt sind die der ersten akzeptierten Einreichung, Bewertungen und Flags beziehen sich auf die kanonische ID. Am Ende der Auswahlphase läuft eine Spezialanimation "Spiritually Linked" (bei aktiver Anonymität ohne Namen, die Namen folgen beim Reveal). Jeder Owner, also jeder Einreicher eines Mitglieds-Uploads, bekommt die Punkte des Songs gemäß der Einstellung "Linked-Punkte". Keiner der Owner darf diesen Song bewerten. AK-2 und AK-3 gelten unverändert.

### 5.5 Synchrones Abspielen
- FR-30 Die Reihenfolge der Songs ist zufällig (injizierte RNG). Jeder Client spielt jeden Ausschnitt über seinen eigenen IFrame Player.
- FR-31 Uhrsynchronisation: Alle Clients, inklusive Host, schätzen ihren Offset zur Serverzeit über `/api/time` (mehrere Samples, Median, RTT/2). Der Abspielbefehl enthält `startAt` in Serverzeit. Clients cuen das Video vorher und starten zum vereinbarten Zeitpunkt.
- FR-32 Drift-Korrektur: Bei einer Abweichung über 750 ms wird per seekTo korrigiert. Ziel: alle Clients innerhalb von ±500 ms.
- FR-33 Robustheit: Werbung, Buffering oder Fehler bei einem einzelnen Client blockieren die Runde nicht. Der Client holt auf oder zeigt "übersprungen" an. Lokaler Lautstärkeregler und Mute.
- FR-34 Während des Abspielens werden Titel, Thumbnail und Fortschrittsbalken angezeigt, bei deaktivierter Anonymität auch der Owner. Button "Genre-Fail": pro Spieler und Song einmal setzbar, nicht für eigene Songs.
- FR-35 Als Player-Host wird `youtube-nocookie.com` verwendet.

### 5.6 Live-Bewertung
- FR-40 Während der Wiedergabephase bewertet jeder Spieler jeden Song, der nicht ihm gehört (inklusive verlinkter Songs), mit einer ganzen Zahl von 0 bis 10. Ein Song ist ab seinem Start (einschließlich des Vorlaufs) bis zum Ende der Wiedergabephase bewertbar und kann bis dahin beliebig geändert werden; wird derselbe Wert erneut gesendet, lehnt der Host das Event als `NOT_READY` ab. Wer nicht bewertet, gibt keine Stimme ab. Das Netzwerkevent ist `RATE {songId, value}`; der Host validiert mit zod die Phase (PLAYBACK), den bereits gestarteten Song, den Rater (nicht Owner), ganzzahlige Werte 0-10 sowie das Rate-Limit und verwirft ungültige oder phasenfremde Events.
- FR-41 Das Genre-Fail-Flag ist auch während der Wiedergabephase setzbar (pro Spieler und Song einmal, nicht für eigene Songs, siehe FR-34).
- FR-42 Die Wiedergabephase endet wie bisher über die Deadline oder eine Host-Aktion; danach ist die Bewertung abgeschlossen.

### 5.7 Wertung
- FR-50 Der Songscore ist der Mittelwert der abgegebenen Bewertungen, als ganze Zehntelpunkte `scoreTenths = round(Summe * 10 / Anzahl)` (kaufmännisch aufgerundet) und mit einer Nachkommastelle angezeigt (z. B. 7.3). Die Owner erhalten den Songscore als Punkte; die Einstellung "Linked-Punkte" (voll oder halbiert, aufgerundet) gilt. Alle Scores, Summen und Deltas im State sind ganzzahlige Zehntelpunkte. Songs mit stimmberechtigten Ratern, aber ohne abgegebene Bewertung, erhalten 0.0 (`basis: 'noRating'`, Reveal-Hinweis "keine Bewertung"). Hat ein Song keinen stimmberechtigten Rater (alle aktiven Spieler sind Owner, also Spiritually Linked), erhält er pauschal 5.0 (50 Zehntel) als Linked-Bonus an jeden Owner ohne Halbierung (`basis: 'noRaters'`) und ist vom Sieger-Bonus ausgeschlossen.
- FR-51 Rundensieger: Der Song mit dem höchsten Score bringt seinen Ownern +2.0 (20 Zehntel). Bei Gleichstand bekommen alle Gleichplatzierten den Bonus.
- FR-52 Genre-Fail: Flaggt mehr als die Hälfte der für diesen Song stimmberechtigten Spieler (alle außer den Ownern) den Song, erhalten die Owner die eingestellte Strafe (in Zehntel) und der Song ist vom Sieger-Bonus ausgeschlossen.
- FR-53 Der Gesamtstand ist die Summe aller Runden und wird mit einer Nachkommastelle angezeigt. Gleichstand im Finale ergibt einen geteilten Platz.
- FR-54 Sonderfälle sind definiert und getestet:
  - Eine Runde ohne eingereichten Song wird übersprungen (`reason: 'noSongs'`), ohne Punkte, Bonus oder Strafe. Ein einzelner Song wird normal bewertet (`reason: 'normal'`, der Song steht in der `playbackOrder`).
  - Ein Spieler hat keine fremden Songs zum Bewerten.
  - Ein Spieler verlässt mitten in der Runde den Raum: seine Einreichung bleibt im Spiel, bereits abgegebene Bewertungen zählen.
  - Host-Wechsel in jeder Phase.

### 5.8 Reveal und Finale
- FR-60 Reveal: Songs werden in aufsteigender Platzierung aufgedeckt (Sieger zuletzt), mit Owner, Punkten, Flags und der Linked-Animation inklusive Namen. Der Rundensieger bekommt eine Jackpot-Animation. Für einen Banger läuft statt der Jackpot-Animation die Vollbild-Show "THIS IS A BANGER" (`src/ui/pf/BangerShow.tsx`, Rezept `banger` in `src/ui/sfx.ts`) über den ganzen Slot. Ein Banger (mindestens eine Bewertung, jede Bewertung 10, Mittelwert also exakt 10.0) wird mit `banger: true` markiert und erhält einen längeren Reveal-Slot (`BANGER_REVEAL_MS = 5000` statt `REVEAL_PER_SONG_MS = 2500`); die Länge der Reveal-Phase ist die Summe der Slots plus `REVEAL_HOLD_MS`. Songs ohne Bewertung zeigen den Hinweis "keine Bewertung", Songs ohne stimmberechtigte Rater den 5.0-Linked-Bonus-Hinweis.
- FR-61 Nach jeder Runde ein Zwischenstand-Leaderboard mit animierten Positionswechseln.
- FR-62 Finale: Podium, Liste aller Rundensieger-Banger mit Links, Button "Nochmal" (zurück in die Lobby, Einstellungen bleiben erhalten).

## 6. UI und UX
- Pixel-Filz: spielerischer Casino-Tisch im Pixel-Look. Dunkler Filz mit langsam wirbelndem Hintergrund, Songs als Spielkarten, Punkte als Chips und Combos, spürbare Bewegung bei jedem Spielereignis. Design-Referenz: docs/design/pixel-filz/ (Brand Book, Tokens, Bausteine). Dezente Soundeffekte (synthetisiert oder CC0, lokal, abschaltbar).
- Keine urheberrechtlich geschützten Assets ohne Lizenz, keine fremden Logos.
- `prefers-reduced-motion` wird respektiert.
- Accessibility: vollständige Tastaturbedienung, Kontraste nach WCAG AA, `aria-live` für Phasenwechsel und Timer.

## 7. Nicht-funktionale Anforderungen
- NFR-01 Performance: Lighthouse Performance Desktop mindestens 90 und Mobile mindestens 80, initiales JS-Bundle unter 250 kB gzip. Die YouTube API wird lazy geladen.
- NFR-02 Netzlast: unter den Limits von Supabase Free bleiben (aktuell ca. 200 gleichzeitige Verbindungen und 100 Nachrichten/s pro Projekt, gegen die Doku prüfen). Keine Ticker-Nachrichten, Timer laufen clientseitig gegen `deadlineAt`.
- NFR-03 Sicherheit:
  - Der Host validiert alle eingehenden Events mit zod und verwirft ungültige oder phasenfremde Events.
  - Rate-Limit pro clientId am Host.
  - Nicknames werden nur als Text gerendert.
  - CSP in `vercel.json`: frame-src nur YouTube, connect-src nur Supabase und eigene API.
  - Im Client nur der anon/publishable Key über Env-Variablen. Secrets werden nie committet.
- NFR-04 Datenschutz: keine Analytics, keine nicht notwendigen Cookies. Hinweis in der UI, dass YouTube-Inhalte eingebettet werden. Gespeichert werden nur die zufällige Spieler-ID und die YouTube-Zustimmung (localStorage); ein Start-Popup holt Zustimmung und Sound-Freigabe mit einem Klick ein, "Ohne Videos" lädt nichts von YouTube, die Zustimmung ist jederzeit widerrufbar.
- NFR-05 Browser: jeweils aktuelle Versionen von Chrome, Firefox, Edge und Safari inklusive iOS.
- NFR-06 Codequalität: TypeScript strict, ESLint und Prettier, kein `any` ohne begründeten Kommentar, Zeilenabdeckung der Engine mindestens 90 %.

## 8. Nicht-Ziele (MVP)
Accounts, Persistenz, spielübergreifende Bestenlisten, Spotify, In-App-YouTube-Suche, öffentliches Matchmaking, Chat, Moderation, Monetarisierung.

In `docs/ROADMAP.md` für Phase 2 vormerken: serverautoritative Engine, In-App-Suche über die YouTube Data API, Playlist-Export der Gewinner, Zuschauer-Modus, Joker/Power-ups, Impressum und Datenschutzerklärung für den öffentlichen Betrieb.

## 9. Team und Orchestrierung

| Subagent | Verantwortung | Liefert |
|---|---|---|
| Engine | State Machine, Wertung, Sonderfälle, testgetrieben | `src/engine` plus Unit-Tests |
| Realtime | GameTransport, Supabase-Adapter, Presence, Reconnect, Host-Migration, Uhrsync | `src/net` plus Tests mit In-Memory-Transport |
| Player | IFrame-Wrapper, Link-Parsing, oEmbed, Embed-Validierung, synchrones Abspielen, Drift-Korrektur | `src/player` plus Tests |
| UI | Screens, Casino-Design, Roulette, Animationen, a11y, i18n | `src/ui`, `src/content` |
| QA/Reviewer | E2E mit 3-4 Browser-Kontexten, Review gegen die Akzeptanzkriterien, Security-Review | `e2e/` plus Review-Berichte |

Regeln:
1. Contract first: Bevor parallel gearbeitet wird, legst du in `src/shared/` die Typen für GameState, Actions und alle Netzwerkevents (zod) fest. Änderungen daran nimmst nur du vor, oder ein Subagent, dessen Issue die Contract-Änderung ausdrücklich freigibt.
2. Jeder Subagent bekommt: Ziel, relevante FR/NFR-IDs, die Contracts, eine Definition of Done und die Verzeichnisse, die er ändern darf.
3. Ein Branch pro Aufgabe, kleine Merges, Conventional Commits. Nach main wird nur gemergt, wenn Lint, Typecheck, Tests und Build grün sind.
4. Unklarheiten: sinnvollen Default wählen, in `docs/OPEN_QUESTIONS.md` mit Begründung festhalten und dem Nutzer gesammelt am Ende des Meilensteins vorlegen. Bei Produktentscheidungen mit großer Tragweite stoppen und fragen.
5. Externe APIs (YouTube IFrame API, oEmbed, Supabase Realtime, Vercel) immer gegen die aktuelle offizielle Doku prüfen, nicht aus dem Gedächtnis implementieren.
6. Der Reviewer ist nie derselbe Agent, der den Code geschrieben hat.
7. Keine Secrets in Repo, Logs oder Prompts an Subagents.
8. Rollen: Der Nutzer ist Owner und Stakeholder (entscheidet Richtung, Design, Prioritäten, spielt Playtests). Die Hauptsession ist PM und Orchestrator: macht aus Wünschen Issues, startet Implementer- und Reviewer-Subagents, prüft das Merge-Gate und mergt. Ablauf, Merge-Gate, maximal drei parallele Subagents, stündlicher Stuck-Check pro Agent und Modell-Leiter stehen in `docs/WORKFLOW.md`.

## 10. Meilensteine
Jeder Meilenstein endet mit Demo und kurzem Statusbericht (erledigt, offen, Risiken, offene Fragen).

- M0 Gerüst: Repo, Tooling, CI, Contracts, ADR-001, leeres Deployment auf Vercel.
- M1 Engine: komplett inklusive Wertung und Sonderfälle, ausschließlich über Unit-Tests verifiziert.
- M2 Lobby und Realtime: Raum erstellen und beitreten, Presence, Einstellungen, Reconnect, Host-Migration.
- M3 Genre-Roulette und Song-Auswahl inklusive Validierung und Spiritually Linked.
- M4 Synchrones Abspielen inklusive Uhrsync und Drift-Korrektur.
- M5 Live-Bewertung, Genre-Fail, Wertung, Reveal und Finale: erstes komplett spielbares Spiel.
- M6 Polish: Casino-Design, Animationen, Sounds, a11y, Performance.
- M7 Release: Produktiv-Deployment, E2E-Smoke-Test gegen das Deployment, README fertig.

## 11. Akzeptanzkriterien
- AK-1 Gegeben 4 Spieler im Raum, wenn der Host startet, dann sehen alle dasselbe Genre und dieselbe Rad-Animation.
- AK-2 Gegeben zwei Spieler reichen dieselbe videoId ein, dann erscheint der Song einmal, die Linked-Animation läuft, beide bekommen die Punkte und keiner von beiden kann ihn bewerten.
- AK-3 Gegeben Anonymität ist an, dann ist bis zum Reveal nirgends in der UI erkennbar, wer welchen Song gewählt hat.
- AK-4 Gegeben der Host schließt den Tab während der Wiedergabephase, dann übernimmt innerhalb von 5 s ein anderer Spieler und das Spiel läuft ohne Datenverlust weiter.
- AK-5 Gegeben ein Spieler lädt die Seite neu, dann ist er innerhalb von 5 s wieder im Raum, mit unverändertem Punktestand.
- AK-6 Gegeben ein Video mit deaktiviertem Embedding, dann wird die Einreichung mit Fehlermeldung abgelehnt.
- AK-7 Gegeben alle Clients haben Sound freigeschaltet, dann starten alle Ausschnitte innerhalb von ±500 ms (messbar über ein Debug-Overlay mit `?debug=1`).
- AK-8 Wertung als Unit-Test: Spieler A, B, C, D mit je einem Song. Bewertungen der fremden Songs: A: C 9, B 5, D 3; B: C 9, A 7, D 3; C: A 7, B 5, D 3; D: C 9, A 7, B 5. Erwartete Songscores: C 9.0, A 7.0, B 5.0, D 3.0. Mit Sieger-Bonus (+2.0): C 11.0, A 7.0, B 5.0, D 3.0.
- AK-9 Gegeben ein Spieler schaltet die Sprache um, dann wechselt die gesamte UI ohne Reload. Ein CI-Check schlägt fehl, wenn in einer Sprache Keys fehlen.

## 12. Deliverables (Definition of Done)
- Lauffähige App auf Vercel, verbunden mit einem Supabase-Projekt.
- README: lokaler Start, Supabase-Projekt anlegen, Env-Variablen (mit `.env.example`), Deploy-Schritte, Hinweis, dass Supabase-Free-Projekte nach Inaktivität pausieren.
- `docs/`: ADRs, `ARCHITECTURE.md` (inklusive Mermaid-Sequenzdiagramm für den Abspielsync), `SECURITY.md` (bekannte Grenzen), `OPEN_QUESTIONS.md`, `ROADMAP.md`.
- Alle Tests in der CI grün, E2E deckt AK-1 bis AK-7 ab.

## 13. Erster Schritt
Lies diese Spezifikation vollständig und prüfe sie auf Widersprüche und Lücken. Liefere dann zuerst:
1. Liste offener Fragen und Risiken.
2. Task-Breakdown für M0 und M1 mit Zuordnung zu Subagents.
3. Entwurf der Contracts in `src/shared/`.

Warte danach auf Freigabe, bevor du Subagents für die Umsetzung startest.
