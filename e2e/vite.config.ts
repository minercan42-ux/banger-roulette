/**
 * Test-only Vite configuration. It serves the test harness
 * (`/e2e/harness.html`) for the landing route and the room deep link, mirrors
 * the same-origin `/api/time` handler and attaches the WebSocket bridge that
 * runs the real in-memory hub. It is never used by `vite build`; the
 * production entry stays `/src/main.tsx` via the root `index.html`, which is
 * still reachable at `/index.html` on this server.
 */
import { fileURLToPath } from 'node:url';
import { Server } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GET } from '../api/time.ts';
import { GET as getOEmbed } from '../api/oembed.ts';
import { attachBridge } from './bridge';

const timeApi: Plugin = {
  name: 'same-origin-time-api',
  configureServer(server) {
    server.middlewares.use('/api/time', async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/') return next();
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const result = GET();
      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      response.end(await result.text());
    });
    server.middlewares.use('/api/oembed', async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/') return next();
      const result = await getOEmbed(
        new Request(
          `http://localhost/api/oembed${request.url?.slice(1) ?? ''}`,
          {
            method: request.method,
          },
        ),
      );
      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      response.end(await result.text());
    });
  },
};

const bridge: Plugin = {
  name: 'test-only-bridge',
  configureServer(server) {
    if (server.httpServer instanceof Server) {
      attachBridge(server.httpServer);
    }
  },
};

/**
 * The harness page replaces the app entry for the landing route and the room
 * deep link, so the real UI router sees `/` and `/r/CODE` exactly as it does in
 * production. Everything else (assets, `/src`, `/api`, the bridge) is untouched.
 */
const harnessEntry: Plugin = {
  name: 'test-only-harness-entry',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const path = request.url?.split('?')[0] ?? '';
      if (
        request.method === 'GET' &&
        (path === '/' || path.startsWith('/r/'))
      ) {
        request.url = '/e2e/harness.html';
      }
      next();
    });
  },
};

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [harnessEntry, react(), tailwindcss(), timeApi, bridge],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
