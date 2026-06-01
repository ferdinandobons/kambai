// watcher.js — chokidar watch of CLAUDE_PROJECTS_DIR for session files.
//
// Two layers:
//
//  1. startWatcher(callbacks) — the low-level primitive declared in the
//     scaffold contract. It watches `**/*.jsonl` under CLAUDE_PROJECTS_DIR and
//     invokes onAdd/onChange/onUnlink with the absolute file path. Coalescing
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
import fs from 'node:fs';

import chokidar from 'chokidar';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { parseSessionFile } from './sessionParser.js';
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
 * chokidar `ignored` predicate. Returns true to ignore a path. We must let
 * directories through (so chokidar keeps descending) and only ignore *files*
 * that aren't .jsonl.
 *
 * chokidar may call this with or without `stats`. When stats are absent we fall
 * back to a cheap check: a path ending in `.jsonl` is always watched; a path
 * with any other extension is treated as a file to ignore; an extension-less
 * path is assumed to be a directory and allowed.
 *
 * @param {string} testPath
 * @param {import('node:fs').Stats} [stats]
 * @returns {boolean}
 */
function ignoreNonJsonl(testPath, stats) {
  if (testPath.endsWith('.jsonl')) return false;

  if (stats) {
    // Ignore only real files that aren't .jsonl; keep directories.
    return stats.isFile();
  }

  // No stats: try to stat, else infer from the extension.
  try {
    const s = fs.statSync(testPath);
    return s.isFile();
  } catch {
    // Path may not exist yet (e.g. about-to-be-created). Allow extension-less
    // paths (likely directories); ignore anything with a non-.jsonl extension.
    return path.extname(testPath) !== '';
  }
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

  // chokidar v4 dropped glob support, so we watch the projects directory
  // recursively and filter to *.jsonl ourselves. The `ignored` predicate must
  // still allow directories through (so chokidar descends into them); only
  // non-.jsonl *files* are ignored.
  const watcher = chokidar.watch(CLAUDE_PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: true, // initial inventory is handled by scanAllSessions()
    ignored: ignoreNonJsonl,
    awaitWriteFinish: {
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 50,
    },
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
 * High-level watcher that maps file-system changes to Kambai domain events and
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
        // File may have been removed or be unreadable; ignore.
      }
    },
    onChange: async (filePath) => {
      try {
        const session = await parseSessionFile(filePath);
        emit({ type: 'session.updated', session });
      } catch {
        // ignore transient read/parse errors
      }
    },
    onUnlink: (filePath) => {
      emit({ type: 'session.removed', id: sessionIdFromPath(filePath) });
    },
  });
}
