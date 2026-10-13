import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GET } from './api/time.ts';

// Vercel serves api/time.ts in production; local Vite calls the same handler.
const timeApi: Plugin = {
  name: 'same-origin-time-api',
  configureServer(server) {
    server.middlewares.use('/api', async (request, response) => {
      if (request.url?.split('?')[0] !== '/time') {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
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
  },
};
export default defineConfig({ plugins: [react(), tailwindcss(), timeApi] });
