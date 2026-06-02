// watcher.js — chokidar watch of CLAUDE_PROJECTS_DIR for session files.
//
// Two layers:
//
//  1. startWatcher(callbacks) — the low-level primitive declared in the
//     scaffold contract. It watches the depth-1 `<uuid>.jsonl` session files
//     under CLAUDE_PROJECTS_DIR (project dirs only, no nested subagent/workflow
//     trees) and invokes onAdd/onChange/onUnlink with the absolute path. Coalescing
//     of rapid writes is handled by chokidar's `awaitWriteFinish` (~300ms), so
//     a flurry of writes to a live session collapses into a single callback.
//
//  2. startSessionWatcher(onEvent) — the cohesive, high-level entrypoint used
//     by index.js. It turns raw file events into domain events:
//       add    -> parseSessionFile + store.ensurePlaced -> {type:'session.added',   session}
//                 then a {type:'store.changed', store} so every client converges
//       change -> parseSessionFile                       -> {type:'session.updated', session}
//       unlink ->                                          {type:'session.removed',  id}
//     and forwards them to `onEvent` (typically the SSE broadcast).

import path from 'node:path';

import chokidar from 'chokidar';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { parseSessionFile } from './sessionParser.js';
import { isSessionFile } from './scanner.js';
import * as store from './store.js';

/** Per-path debounce window in milliseconds. */
const DEBOUNCE_MS = 300;

/**
 * @typedef {Object} WatcherCallbacks
 * @property {(filePath: string) => void} [onAdd]
 * @property {(filePath: string) => void} [onChange]
 * @property {(filePath: string) => void} [onUnlink]
 */

/**
 * @typedef {Object} WatcherHandle
 * @property {() => Promise<void>} close - Stop watching and release resources.
 */

/**
 * chokidar `ignored` predicate. Returns true to IGNORE a path. We watch only the
 * projects root, its DIRECT project subdirectories, and the `<uuid>.jsonl`
 * session files inside them — and never descend into the per-session `<uuid>/`
 * subtrees (subagent transcripts, workflow journals), whose files are not
 * sessions and whose basenames collide.
 *
 * chokidar may call this with or without `stats`. A `.jsonl` path is judged by
 * isSessionFile (depth-1 + uuid name); anything else is treated as a directory
 * and allowed only when it is a direct child of the projects root.
 *
 * @param {string} testPath
 * @param {import('node:fs').Stats} [stats]
 * @returns {boolean}
 */
function ignored(testPath, stats) {
  const resolved = path.resolve(testPath);
  const base = path.resolve(CLAUDE_PROJECTS_DIR);
  if (resolved === base) return false; // always watch the projects root

  if (testPath.endsWith('.jsonl')) {
    // Watch only genuine depth-1 session files; ignore nested / oddly-named ones.
    return !isSessionFile(resolved);
  }

  // Treat anything else as a directory: allow only the direct children of the
  // projects root (the project dirs). Ignore deeper dirs and stray files so
  // chokidar never descends into the nested subagent/workflow trees.
  if (stats && stats.isFile()) return true;
  return path.dirname(resolved) !== base;
}

/**
 * Extract the session id (UUID) from a .jsonl file path: the basename without
 * its extension.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function sessionIdFromPath(filePath) {
  return path.basename(filePath, '.jsonl');
}

/**
 * Start watching session files. Returns a handle exposing close().
 *
 * Coalescing of rapid writes is delegated to chokidar's `awaitWriteFinish`:
 * an add/change event for a file fires only once the file has been size-stable
 * for ~300ms, so a flurry of writes to a live session collapses into a single
 * callback. We therefore invoke the callbacks directly, with no second debounce
 * layer of our own.
 *
 * @param {WatcherCallbacks} callbacks
 * @returns {WatcherHandle}
 */
export function startWatcher(callbacks = {}) {
  const { onAdd, onChange, onUnlink } = callbacks;

  // chokidar v4 dropped glob support, so we watch the projects directory and
  // filter ourselves. The `ignored` predicate keeps us to the projects root,
  // its direct project dirs, and depth-1 `<uuid>.jsonl` session files — it never
  // descends into the nested subagent/workflow subtrees.
  const watcher = chokidar.watch(CLAUDE_PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: true, // initial inventory is handled by scanAllSessions()
    ignored,
    // Do NOT follow symlinks: a .jsonl symlink whose target lives outside
    // CLAUDE_PROJECTS_DIR would otherwise be read and its contents disclosed
    // over SSE, violating the read-containment contract. This matches the
    // scanner's walk(), which skips symlinks via Dirent.isFile()/isDirectory().
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 50,
    },
  });

  // Always handle 'error': chokidar's FSWatcher is an EventEmitter, and an
  // emitted 'error' with no listener throws (crashing the process). A watch
  // error (EMFILE on large trees, a permission change, the projects dir being
  // replaced) is logged here so it never becomes an unhandled emitter error and
  // the rest of the app keeps running.
  watcher.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[watcher]', err);
  });

  if (typeof onAdd === 'function') {
    watcher.on('add', (filePath) => onAdd(path.resolve(filePath)));
  }
  if (typeof onChange === 'function') {
    watcher.on('change', (filePath) => onChange(path.resolve(filePath)));
  }
  if (typeof onUnlink === 'function') {
    watcher.on('unlink', (filePath) => onUnlink(path.resolve(filePath)));
  }

  return {
    async close() {
      await watcher.close();
    },
  };
}

/**
 * High-level watcher that maps file-system changes to KanbAI domain events and
 * forwards them to `onEvent`. This is what index.js wires to the SSE hub.
 *
 * Mapping:
 *   add    -> parse + store.ensurePlaced -> { type: 'session.added',   session }
 *             then { type: 'store.changed', store } so every client converges
 *             on the server's placement of the new card.
 *   change -> parse                      -> { type: 'session.updated', session }
 *   unlink ->                               { type: 'session.removed',  id }
 *
 * Parse failures (e.g. the file vanished between the event and the read) are
 * swallowed so a transient read error never crashes the watcher.
 *
 * @param {(event: import('./sse.js').SseEvent) => void} onEvent
 * @returns {WatcherHandle}
 */
export function startSessionWatcher(onEvent) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  return startWatcher({
    onAdd: async (filePath) => {
      if (!isSessionFile(filePath)) return; // defensive: never a nested journal
      try {
        const session = await parseSessionFile(filePath);
        // New session → make sure it has a board placement (first column).
        store.ensurePlaced(session.id);
        emit({ type: 'session.added', session });
        // ensurePlaced wrote a new overlay entry; broadcast the authoritative
        // store so every connected client converges on the server's placement
        // (not just the originating client's columns[0] fallback).
        emit({ type: 'store.changed', store: store.getBoard() });
      } catch {
        // File may have been removed (or be unreadable) between the event and the
        // read — e.g. an editor's atomic-rename create-then-replace. If we already
        // ensurePlaced'd before the read failed, the overlay row is a harmless
        // orphan that the next GET /api/sessions reconciliation (pruneOverlay
        // against the on-disk scan) self-heals. Nothing to do here.
      }
    },
    onChange: async (filePath) => {
      if (!isSessionFile(filePath)) return;
      try {
        const session = await parseSessionFile(filePath);
        emit({ type: 'session.updated', session });
      } catch {
        // ignore transient read/parse errors
      }
    },
    onUnlink: (filePath) => {
      if (!isSessionFile(filePath)) return;
      const id = sessionIdFromPath(filePath);
      // The DELETE /api/sessions/:id route also unlinks the file, so this event
      // fires for a delete the route already handled (it emitted session.removed
      // + store.changed and dropped the overlay entry). Detect that case via
      // removeOverlay's "changed" return so we don't double-broadcast or, worse,
      // wipe a freshly re-added overlay entry for the same id. Only an out-of-
      // band removal (KanbAI not the one deleting) still has an overlay entry.
      const removed = store.removeOverlay(id);
      if (!removed) return; // already reconciled by the DELETE route — no-op.
      emit({ type: 'session.removed', id });
      // Broadcast the authoritative store so clients converge on the removal.
      emit({ type: 'store.changed', store: store.getBoard() });
    },
  });
}
