import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as z from 'zod';

/**
 * zod probes for `eval` support with `new Function("")` the first time a schema
 * is built, and caches the answer. Under the production Content-Security-Policy
 * (`script-src 'self'`, no `'unsafe-eval'`) that swallowed probe is reported as
 * a `securitypolicyviolation` on every page load, so jitless mode is enabled
 * before any schema exists. zod reads the flag when a schema is constructed,
 * which is why the app modules are imported dynamically below: a static import
 * would be evaluated before this statement and build the schemas first.
 */
z.config({ jitless: true });

const [{ Shell }, { createBrowserSession }] = await Promise.all([
  import('./ui/Shell'),
  import('./net/browser'),
]);

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
const session = createBrowserSession();
createRoot(root).render(
  <StrictMode>
    <Shell session={session} />
  </StrictMode>,
);
