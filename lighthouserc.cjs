/**
 * Lighthouse CI gate for NFR-01: Performance >= 90 on desktop, >= 80 on mobile.
 *
 * One config drives both passes; `pnpm lighthouse` runs it twice and selects the
 * device pass plus its output directory through the environment. `lhci` clears
 * its scratch directory (`.lighthouseci/`) on every `collect`, so each pass
 * asserts only its own runs. Each pass gates the median (not LHCI's default
 * `optimistic` aggregation) of its three runs per URL.
 *
 * The production build runs without Supabase env, so the app falls back to the
 * inert session, which still renders the landing page and the room deep link.
 * `vite preview` serves a single page application, so `/r/ABCDEF` resolves to
 * `index.html` exactly as the Vercel rewrite does in production.
 *
 * The `startServerCommand` is inlined instead of a package script: the
 * repository's `package.json` scripts are a shared CI contract, and the only
 * existing preview invocation belongs to `playwright.csp.config.ts`.
 */
const mobile = process.env.LHCI_DEVICE === 'mobile';

module.exports = {
  ci: {
    collect: {
      startServerCommand:
        'pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1',
      // `vite preview` prints "➜  Local:   http://127.0.0.1:4173/". With color
      // enabled (CI: no `NO_COLOR`, `TERM=xterm`) the banner is
      // "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m: ...", so an escape
      // sequence sits between `Local` and `:` and a literal `Local:` never
      // matches. The word itself is never split by an escape, and `\b` also
      // holds when the chunk ends right after it, so match the word, not the
      // colon.
      startServerReadyPattern: 'Local\\b',
      startServerReadyTimeout: 30_000,
      url: ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/r/ABCDEF'],
      numberOfRuns: 3,
      // Lighthouse emulates a mobile device by default, so only the desktop
      // pass needs an explicit preset. Chrome's user-namespace sandbox is
      // unavailable in unprivileged containers (AppArmor restricts unprivileged
      // user namespaces on Ubuntu >= 23.10), which is where this gate also runs
      // locally; the flag is the same one Playwright applies to its own browser
      // launches.
      settings: mobile
        ? { chromeFlags: ['--no-sandbox'] }
        : { preset: 'desktop', chromeFlags: ['--no-sandbox'] },
    },
    assert: {
      // Print the gated value per URL even when the assertion passes, so the
      // median that the gate used is visible in the CI log.
      includePassedAssertions: true,
      assertions: {
        // `aggregationMethod` defaults to `optimistic` (the best of the runs),
        // which would hide regressions behind one lucky run; gate on the median
        // of the `numberOfRuns` runs collected per URL instead.
        'categories:performance': [
          'error',
          { aggregationMethod: 'median', minScore: mobile ? 0.8 : 0.9 },
        ],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: mobile ? 'lhci/mobile' : 'lhci/desktop',
    },
  },
};
