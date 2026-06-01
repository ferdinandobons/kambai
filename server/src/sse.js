// sse.js — Server-Sent Events hub.
//
// Maintains a set of connected client streams (Fastify replies). `addClient`
// registers a reply as an SSE stream: it sets the proper SSE headers, starts a
// keep-alive ping, and removes the client automatically on disconnect.
// `broadcast` serializes an event as JSON and writes it to every connected
// client. The hub is process-wide (module-level singleton) so the watcher and
// the routes can push to it without threading a reference through every call.

/**
 * @typedef {Object} SseEvent
 * @property {string} type - e.g. "session.added", "session.updated",
 *                           "session.removed", "store.changed".
 * @property {*} [session]
 * @property {string} [id]
 * @property {*} [store]
 */

/**
 * @typedef {Object} SseClient
 * @property {import('node:http').ServerResponse} res - Raw response stream.
 * @property {NodeJS.Timeout} keepAlive - Keep-alive interval handle.
 */

/** Interval (ms) between keep-alive comments to hold the connection open. */
const KEEP_ALIVE_MS = 25_000;

/** @type {Set<SseClient>} */
const clients = new Set();

/**
 * Register a Fastify reply as an SSE client. Sets up the SSE headers/stream,
 * starts a keep-alive heartbeat, and removes the client on disconnect.
 *
 * The caller MUST return `reply` (or call `reply.hijack()`-style by not sending
 * a body) so Fastify does not try to send its own response — see routes.js,
 * which hijacks the reply before calling this.
 *
 * @param {import('fastify').FastifyReply} reply
 * @returns {void}
 */
export function addClient(reply) {
  const res = reply.raw;

  // SSE headers. We write them directly on the raw response so Fastify does not
  // interfere with the long-lived stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (e.g. nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });

  // Initial comment + a retry hint so the browser EventSource reconnects fast.
  res.write(': connected\n\n');
  res.write('retry: 3000\n\n');

  const keepAlive = setInterval(() => {
    // A line starting with ':' is an SSE comment, ignored by the client but
    // enough to keep intermediaries from closing an idle connection.
    try {
      res.write(': ping\n\n');
    } catch {
      // If writing fails the connection is gone; cleanup runs via 'close'.
    }
  }, KEEP_ALIVE_MS);
  // Don't let the heartbeat keep the event loop (and tests) alive.
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  /** @type {SseClient} */
  const client = { res, keepAlive };
  clients.add(client);

  const cleanup = () => {
    clearInterval(keepAlive);
    clients.delete(client);
  };

  // `close` fires when the client disconnects or the response ends.
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Broadcast an event to all connected SSE clients. The event is serialized as
 * JSON in the SSE `data:` field. Dead clients are pruned defensively.
 *
 * @param {SseEvent} event
 * @returns {void}
 */
export function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clearInterval(client.keepAlive);
      clients.delete(client);
    }
  }
}

/**
 * Current number of connected SSE clients. Exposed mainly for tests/diagnostics.
 * @returns {number}
 */
export function clientCount() {
  return clients.size;
}

/**
 * Disconnect every client and clear the hub. Used on shutdown and in tests so
 * no keep-alive timers leak between runs.
 * @returns {void}
 */
export function closeAll() {
  for (const client of clients) {
    clearInterval(client.keepAlive);
    try {
      client.res.end();
    } catch {
      // already closed
    }
  }
  clients.clear();
}
