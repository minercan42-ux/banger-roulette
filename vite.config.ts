import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GET } from './api/time.ts';
import { GET as getOEmbed } from './api/oembed.ts';

// Vercel serves the same Web handlers in production.
const sameOriginApi: Plugin = {
  name: 'same-origin-api',
  configureServer(server) {
    server.middlewares.use('/api', async (request, response) => {
      const path = request.url?.split('?')[0];
      if (path !== '/time' && path !== '/oembed') {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const result =
        path === '/time'
          ? GET()
          : await getOEmbed(
              new Request(`http://localhost/api${request.url}`, {
                method: request.method,
              }),
            );
      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      response.end(await result.text());
    });
  },
};
export default defineConfig({
  plugins: [react(), tailwindcss(), sameOriginApi],
});
