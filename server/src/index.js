// index.js — Fastify app entrypoint.
//
// buildApp() constructs and configures the Fastify instance (routes, optional
// static serving of web/dist) WITHOUT listening or starting the watcher, so it
// can be imported and exercised in tests. start() builds the app, starts the
// file watcher wired to the SSE hub, and listens on PORT. The direct-invocation
// guard at the bottom calls start() only when this file is run as a script.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { PORT } from './config.js';
import { registerRoutes } from './routes.js';
import { startSessionWatcher } from './watcher.js';
import { broadcast, closeAll as closeSse } from './sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// <repo>/web/dist — served statically when a production build is present.
const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');

/**
 * Build and configure a Fastify instance: register all routes, and serve
 * web/dist as static (SPA fallback) when that directory exists. Does NOT call
 * listen() and does NOT start the watcher — that is start()'s job — so this is
 * safe to import in tests.
 *
 * @param {import('fastify').FastifyServerOptions} [opts]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
// Cap on the accepted request body. Every Kanbai mutation body is tiny (a
// column id list, a title, a boolean), so a modest 256 KB ceiling rejects
// absurd payloads early instead of relying on Fastify's larger default.
const BODY_LIMIT = 256 * 1024;

export async function buildApp(opts = {}) {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, ...opts });

  // Register API + SSE routes.
  await app.register(registerRoutes);

  // Serve the built frontend in production, if present. The static plugin is
  // loaded lazily so the server runs fine before the frontend is built.
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      wildcard: false, // let us add an explicit SPA fallback below
    });

    // SPA fallback: any GET that isn't an API/SSE route and wasn't a real file
    // returns index.html so client-side routing works.
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        !request.url.startsWith('/events')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

/**
 * Build the app, start the session watcher (wired to the SSE hub), and listen
 * on PORT. Returns the running Fastify instance. The instance is decorated with
 * a `close()` that also tears down the watcher and SSE clients.
 *
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function start() {
  const app = await buildApp();

  // Wire the file watcher's domain events into the SSE broadcast.
  const watcher = startSessionWatcher((event) => broadcast(event));

  // Ensure the watcher and SSE clients are cleaned up when the app closes.
  app.addHook('onClose', async () => {
    await watcher.close();
    closeSse();
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  // eslint-disable-next-line no-console
  console.log(`Kanbai backend listening on http://127.0.0.1:${PORT}`);

  return app;
}

// Run when invoked directly (node src/index.js). Guarded so importing this
// module in tests does not start listening.
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
