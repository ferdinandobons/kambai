// routes.js — registers every REST endpoint (prefix /api) plus the SSE
// GET /events endpoint on the Fastify instance.
//
// Endpoints (see spec):
//   GET    /api/sessions          -> { sessions (merged with overlay), columns }
//   GET    /api/board             -> Store
//   POST   /api/cards/:id/move    { columnId, order }
//   POST   /api/cards/:id/archive { archived }
//   DELETE /api/sessions/:id      -> delete the .jsonl from disk (UUID-guarded,
//                                    path-contained in CLAUDE_PROJECTS_DIR)
//   POST   /api/columns           { name } -> column
//   PATCH  /api/columns/:id       { name }
//   POST   /api/columns/reorder   { ids: [] }
//   DELETE /api/columns/:id       { moveCardsTo }
//   GET    /events                -> SSE
//
// After any mutation of the overlay or columns we broadcast
// { type: 'store.changed', store } so connected clients stay in sync.

import path from 'node:path';
import fs from 'node:fs/promises';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { scanAllSessions, listSessionFiles } from './scanner.js';
import { parseSessionFile } from './sessionParser.js';
import { sessionIdFromPath } from './watcher.js';
import * as store from './store.js';
import { addClient, broadcast } from './sse.js';

/**
 * UUID v4 matcher. The version nibble must be 4 and the variant nibble one of
 * 8/9/a/b. Used to validate the :id path param before touching the filesystem.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Broadcast the current store to all SSE clients after a mutation.
 */
function broadcastStore() {
  broadcast({ type: 'store.changed', store: store.getBoard() });
}

/**
 * Resolve the absolute, real path of the .jsonl file for a given session id and
 * verify it is contained within CLAUDE_PROJECTS_DIR. Returns the safe absolute
 * path, or null if no such file exists under the projects directory.
 *
 * Security: we never trust the id to build a path directly. We enumerate the
 * actual session files, match by basename, then re-verify containment with
 * path.resolve so neither traversal nor a symlink can escape the projects dir.
 *
 * @param {string} id - Already UUID-v4-validated session id.
 * @returns {Promise<string|null>}
 */
async function resolveSessionFile(id) {
  const files = await listSessionFiles();
  // Resolve the base through realpath so the containment comparison is
  // symlink-consistent with the candidate's realpath below (macOS home dirs are
  // commonly symlinked). Fall back to a plain resolve if the dir is missing.
  let base;
  try {
    base = await fs.realpath(path.resolve(CLAUDE_PROJECTS_DIR));
  } catch {
    base = path.resolve(CLAUDE_PROJECTS_DIR);
  }

  for (const file of files) {
    if (sessionIdFromPath(file) !== id) continue;

    // Resolve the candidate and ensure it stays inside the projects dir.
    const resolved = path.resolve(file);
    if (!isInside(base, resolved)) continue;

    // Resolve symlinks too: realpath must also remain inside the projects dir.
    let real;
    try {
      real = await fs.realpath(resolved);
    } catch {
      continue;
    }
    if (!isInside(base, real)) continue;

    return real;
  }
  return null;
}

/**
 * True iff `target` is the base directory itself or lives strictly inside it.
 * Uses path.relative so it is robust to ".." segments and trailing slashes.
 *
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Merge scanned sessions with the store overlay, attaching columnId/order/
 * archived to each session. Sessions without an overlay entry are returned with
 * null overlay fields (the client/ensurePlaced will sort them out).
 *
 * NOTE: this overlay-merge rule is mirrored client-side in web/src/App.jsx
 * (mergeOverlay). Keep the two in sync when changing the merged shape.
 *
 * @param {import('./sessionParser.js').SessionMeta[]} sessions
 * @param {import('./store.js').Store} board
 * @returns {Array<object>}
 */
/**
 * Parse a SINGLE session's meta by id without re-scanning every project file.
 * Walks the (cheap) file listing, matches by id, and parses just that one file.
 *
 * @param {string} id
 * @returns {Promise<import('./sessionParser.js').SessionMeta|null>}
 */
async function findSessionMeta(id) {
  const files = await listSessionFiles();
  for (const file of files) {
    if (sessionIdFromPath(file) !== id) continue;
    try {
      return await parseSessionFile(file);
    } catch {
      return null;
    }
  }
  return null;
}

function mergeSessions(sessions, board) {
  return sessions.map((session) => {
    const entry = board.overlay[session.id];
    return {
      ...session,
      columnId: entry ? entry.columnId : null,
      order: entry ? entry.order : null,
      archived: entry ? entry.archived : false,
      lastDoneActivity: entry ? entry.lastDoneActivity : null,
    };
  });
}

/**
 * Register all Kambai routes on the given Fastify instance.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Promise<void>}
 */
export async function registerRoutes(fastify) {
  // ---- GET /api/sessions -------------------------------------------------
  // All sessions merged with overlay, plus the columns. New sessions are
  // ensurePlaced so the board is always complete.
  fastify.get('/api/sessions', async () => {
    const sessions = await scanAllSessions();
    let board = store.getBoard();

    // Place any session with no overlay entry yet (always the first column) in a
    // single batched write, regardless of how many are new.
    const unplaced = sessions.filter((s) => !board.overlay[s.id]).map((s) => s.id);
    if (unplaced.length > 0) {
      store.batchEnsurePlaced(unplaced);
      board = store.getBoard();
      broadcastStore();
    }

    return { sessions: mergeSessions(sessions, board), columns: board.columns };
  });

  // ---- GET /api/board ----------------------------------------------------
  fastify.get('/api/board', async () => store.getBoard());

  // ---- POST /api/cards/:id/move ------------------------------------------
  fastify.post('/api/cards/:id/move', async (request, reply) => {
    const { id } = request.params;
    const { columnId, order } = request.body ?? {};

    if (typeof columnId !== 'string' || typeof order !== 'number') {
      return reply.code(400).send({ error: 'columnId (string) and order (number) are required' });
    }

    const board = store.getBoard();
    if (!board.columns.some((c) => c.id === columnId)) {
      return reply.code(404).send({ error: 'column not found' });
    }

    // When moving into the "done" column, moveCard stamps lastDoneActivity with
    // the session's current lastActivity so the "riattivata" badge can later
    // trigger. Parse just this one session (null if unknown) — no full re-scan.
    const meta = await findSessionMeta(id);
    const lastActivity = meta ? meta.lastActivity : null;

    store.moveCard(id, columnId, order, lastActivity);
    broadcastStore();
    return store.getBoard();
  });

  // ---- POST /api/cards/:id/archive ---------------------------------------
  fastify.post('/api/cards/:id/archive', async (request, reply) => {
    const { id } = request.params;
    const { archived } = request.body ?? {};

    if (typeof archived !== 'boolean') {
      return reply.code(400).send({ error: 'archived (boolean) is required' });
    }

    store.setArchived(id, archived);
    broadcastStore();
    return store.getBoard();
  });

  // ---- DELETE /api/sessions/:id ------------------------------------------
  // SECURITY: id must be UUID v4; the resolved file must live inside
  // CLAUDE_PROJECTS_DIR (no traversal, no symlink escape). 404 if not found.
  fastify.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;

    if (!UUID_V4.test(id)) {
      return reply.code(400).send({ error: 'invalid session id' });
    }

    const file = await resolveSessionFile(id);
    if (!file) {
      return reply.code(404).send({ error: 'session not found' });
    }

    try {
      await fs.unlink(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'session not found' });
      }
      throw err;
    }

    // Drop the overlay entry and notify clients (overlay change + removal).
    store.removeOverlay(id);
    broadcast({ type: 'session.removed', id });
    broadcastStore();
    return { deleted: id };
  });

  // ---- POST /api/columns -------------------------------------------------
  fastify.post('/api/columns', async (request, reply) => {
    const { name } = request.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'name (non-empty string) is required' });
    }
    const column = store.addColumn(name.trim());
    broadcastStore();
    return column;
  });

  // ---- PATCH /api/columns/:id --------------------------------------------
  fastify.patch('/api/columns/:id', async (request, reply) => {
    const { id } = request.params;
    const { name } = request.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'name (non-empty string) is required' });
    }
    const board = store.getBoard();
    if (!board.columns.some((c) => c.id === id)) {
      return reply.code(404).send({ error: 'column not found' });
    }
    store.renameColumn(id, name.trim());
    broadcastStore();
    return store.getBoard();
  });

  // ---- POST /api/columns/reorder -----------------------------------------
  fastify.post('/api/columns/reorder', async (request, reply) => {
    const { ids } = request.body ?? {};
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
      return reply.code(400).send({ error: 'ids (string[]) is required' });
    }
    store.reorderColumns(ids);
    broadcastStore();
    return store.getBoard();
  });

  // ---- DELETE /api/columns/:id -------------------------------------------
  fastify.delete('/api/columns/:id', async (request, reply) => {
    const { id } = request.params;
    const { moveCardsTo } = request.body ?? {};

    const board = store.getBoard();
    if (!board.columns.some((c) => c.id === id)) {
      return reply.code(404).send({ error: 'column not found' });
    }
    if (typeof moveCardsTo !== 'string' || !board.columns.some((c) => c.id === moveCardsTo)) {
      return reply.code(400).send({ error: 'moveCardsTo must reference an existing column' });
    }
    if (moveCardsTo === id) {
      return reply.code(400).send({ error: 'moveCardsTo must differ from the deleted column' });
    }

    store.deleteColumn(id, moveCardsTo);
    broadcastStore();
    return store.getBoard();
  });

  // ---- GET /events (SSE) -------------------------------------------------
  // Hijack the reply so Fastify leaves the raw stream to the SSE hub, which
  // writes headers, keep-alives, and events itself.
  fastify.get('/events', (request, reply) => {
    reply.hijack();
    addClient(reply);
  });
}

export default registerRoutes;
