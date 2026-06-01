// store.js — Kanban overlay state. Manages data/store.json: the per-session
// overlay (which column a card sits in, its order, archived flag, and the
// "done" activity marker) plus the columns themselves.
//
// Persistence rules:
//  - Writes are ATOMIC: serialize to <path>.tmp, then rename over <path>.
//  - A corrupt/unparseable store file is backed up to <path>.bak and replaced
//    with defaults rather than throwing.
//  - Column ids are STABLE and deterministic: a slug of the column name plus an
//    incrementing counter (`nextColumnId`) persisted in the store. They are NOT
//    derived from time or randomness, so they are reproducible in tests.
//
// Store path resolution (override for tests):
//  - If the env var KAMBAI_STORE_PATH is set, that path is used.
//  - Otherwise STORE_PATH from config.js is used.
//  The path is resolved per-operation, so a test can point KAMBAI_STORE_PATH at
//  a temporary file and the module will read/write there without touching the
//  real data/store.json. config.js is treated as final and only imported here.

import fs from 'node:fs';
import path from 'node:path';

import { STORE_PATH } from './config.js';

/**
 * @typedef {Object} Column
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {number} order
 */

/**
 * @typedef {Object} OverlayEntry
 * @property {string} columnId
 * @property {number} order
 * @property {boolean} archived
 * @property {string|null} lastDoneActivity
 */

/**
 * @typedef {Object} Store
 * @property {number} version
 * @property {Column[]} columns
 * @property {Object.<string, OverlayEntry>} overlay
 * @property {number} nextColumnId
 */

const STORE_VERSION = 1;

// Default palette cycled through when creating columns.
const COLUMN_COLORS = ['#64748b', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed'];

/**
 * Resolve the on-disk store path. Honors KAMBAI_STORE_PATH (used by tests) and
 * falls back to STORE_PATH from config.js. Resolved per-call so tests can
 * override it between operations.
 * @returns {string}
 */
function resolveStorePath() {
  const override = process.env.KAMBAI_STORE_PATH;
  return override && override.length > 0 ? override : STORE_PATH;
}

/**
 * Build a fresh default store: the three default columns and an empty overlay.
 * @returns {Store}
 */
function defaultStore() {
  return {
    version: STORE_VERSION,
    nextColumnId: 4,
    columns: [
      { id: 'da-fare-1', name: 'To do', color: COLUMN_COLORS[0], order: 0 },
      { id: 'in-corso-2', name: 'In progress', color: COLUMN_COLORS[1], order: 1 },
      { id: 'fatto-3', name: 'Done', color: COLUMN_COLORS[2], order: 2 },
    ],
    overlay: {},
  };
}

/**
 * Turn a column name into a URL-/id-safe slug. Non-alphanumeric runs collapse
 * to a single dash; leading/trailing dashes are trimmed. Empty results fall
 * back to "col" so an id can always be formed.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'col';
}

/**
 * Validate the shape of a parsed store object. Used to decide whether an
 * on-disk file is usable or must be treated as corrupt.
 * @param {unknown} obj
 * @returns {obj is Store}
 */
function isValidStore(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!Array.isArray(obj.columns)) return false;
  if (!obj.overlay || typeof obj.overlay !== 'object' || Array.isArray(obj.overlay)) return false;
  for (const col of obj.columns) {
    if (!col || typeof col !== 'object') return false;
    if (typeof col.id !== 'string' || typeof col.name !== 'string') return false;
    if (typeof col.order !== 'number') return false;
  }
  return true;
}

/**
 * Normalize a freshly loaded store so downstream code can rely on every field
 * being present (color, nextColumnId, overlay entry shape, sorted columns).
 * @param {Store} store
 * @returns {Store}
 */
function normalizeStore(store) {
  store.version = STORE_VERSION;

  // Ensure columns are sorted by order and have a color.
  store.columns.sort((a, b) => a.order - b.order);
  store.columns.forEach((col, i) => {
    col.order = i;
    if (typeof col.color !== 'string') {
      col.color = COLUMN_COLORS[i % COLUMN_COLORS.length];
    }
  });

  // Derive a safe nextColumnId: never reuse an id, even after a corrupt edit.
  let maxCounter = 0;
  for (const col of store.columns) {
    const m = /-(\d+)$/.exec(col.id);
    if (m) maxCounter = Math.max(maxCounter, Number.parseInt(m[1], 10));
  }
  if (typeof store.nextColumnId !== 'number' || store.nextColumnId <= maxCounter) {
    store.nextColumnId = maxCounter + 1;
  }

  // Normalize overlay entries.
  for (const [sessionId, entry] of Object.entries(store.overlay)) {
    if (!entry || typeof entry !== 'object') {
      delete store.overlay[sessionId];
      continue;
    }
    if (typeof entry.archived !== 'boolean') entry.archived = false;
    if (typeof entry.order !== 'number') entry.order = 0;
    if (!('lastDoneActivity' in entry)) entry.lastDoneActivity = null;
  }

  return store;
}

/**
 * Atomically write a store to disk: serialize to <path>.tmp then rename over the
 * real path. The parent directory is created if it does not exist.
 * @param {Store} store
 */
function writeStore(store) {
  const storePath = resolveStorePath();
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${storePath}.tmp`;
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, storePath);
}

/**
 * Load the store from disk (or initialize defaults). A corrupt store file is
 * backed up to <path>.bak and replaced with defaults instead of throwing.
 * @returns {Store}
 */
export function loadStore() {
  const storePath = resolveStorePath();

  let raw;
  try {
    raw = fs.readFileSync(storePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // First run: create and persist defaults.
      const store = defaultStore();
      writeStore(store);
      return store;
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!isValidStore(parsed)) {
      throw new Error('store failed schema validation');
    }
  } catch {
    // Corrupt store: back it up and start clean.
    try {
      fs.renameSync(storePath, `${storePath}.bak`);
    } catch {
      // If even the backup rename fails, fall back to a best-effort copy so we
      // never lose the chance to reset to defaults.
      try {
        fs.writeFileSync(`${storePath}.bak`, raw, 'utf8');
      } catch {
        /* give up on the backup, but still reset to defaults below */
      }
    }
    const store = defaultStore();
    writeStore(store);
    return store;
  }

  return normalizeStore(parsed);
}

/**
 * Deep clone helper for serving safe copies to callers.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Return a safe (deep) copy of the current store for serving to clients.
 * @returns {Store}
 */
export function getBoard() {
  return clone(loadStore());
}

/**
 * Locate a column by id within a store.
 * @param {Store} store
 * @param {string} id
 * @returns {Column|undefined}
 */
function findColumn(store, id) {
  return store.columns.find((c) => c.id === id);
}

/**
 * Identify the "done" column id: the one with the highest `order` (for v1,
 * "done" = the last column). Returns null if the board has no columns.
 * @param {Store} store
 * @returns {string|null}
 */
function doneColumnId(store) {
  let done = null;
  let maxOrder = -Infinity;
  for (const col of store.columns) {
    if (col.order > maxOrder) {
      maxOrder = col.order;
      done = col.id;
    }
  }
  return done;
}

/**
 * Move a card to a column, inserting it at `order` and renumbering the
 * destination column's cards to a contiguous 0..n-1 sequence so stored orders
 * stay unique and deterministic. Creates the overlay entry if the session has
 * none yet. Throws if the target column does not exist.
 *
 * When the target is the "done" column (highest `order`) and a current
 * `lastActivity` is supplied, stamps `entry.lastDoneActivity = lastActivity`.
 * Later activity (lastActivity > lastDoneActivity) then lights the "riattivata"
 * badge. Moving out of done leaves the marker intact.
 *
 * @param {string} sessionId
 * @param {string} columnId
 * @param {number} order - Desired insertion index in the destination column.
 * @param {string|null} [lastActivity] - The session's current lastActivity,
 *   used to stamp the done marker when entering the done column.
 * @returns {Store}
 */
export function moveCard(sessionId, columnId, order, lastActivity = null) {
  const store = loadStore();
  if (!findColumn(store, columnId)) {
    throw new Error(`unknown column: ${columnId}`);
  }

  const existing = store.overlay[sessionId];
  const entry = existing ?? { columnId, order, archived: false, lastDoneActivity: null };
  entry.columnId = columnId;
  entry.order = order;
  store.overlay[sessionId] = entry;

  // Stamp the "done" marker when the card enters the done column. Leave it
  // intact otherwise so a later lastActivity > lastDoneActivity reactivates it.
  if (columnId === doneColumnId(store) && lastActivity != null) {
    entry.lastDoneActivity = lastActivity;
  }

  // Keep the destination column free of duplicate orders. The moved card keeps
  // its requested index; every other sibling is renumbered around it into the
  // remaining slots (in their current order), so the column stays a unique,
  // gap-free 0..n-1 sequence around the insertion point.
  const others = Object.entries(store.overlay)
    .filter(([id, e]) => e.columnId === columnId && id !== sessionId)
    .sort((a, b) => a[1].order - b[1].order);
  let slot = 0;
  for (const [, e] of others) {
    if (slot === order) slot += 1; // reserve the moved card's requested index
    e.order = slot;
    slot += 1;
  }

  writeStore(store);
  return store;
}

/**
 * Archive / unarchive a card. Creates an overlay entry (placed in the first
 * column) if the session has none yet so the archived state can be persisted.
 * @param {string} sessionId
 * @param {boolean} archived
 * @returns {Store}
 */
export function setArchived(sessionId, archived) {
  const store = loadStore();
  let entry = store.overlay[sessionId];
  if (!entry) {
    const first = store.columns[0];
    entry = {
      columnId: first ? first.id : '',
      order: 0,
      archived: Boolean(archived),
      lastDoneActivity: null,
    };
    store.overlay[sessionId] = entry;
  } else {
    entry.archived = Boolean(archived);
  }

  writeStore(store);
  return store;
}

/**
 * Remove a session's overlay entry entirely (e.g. after permanent delete).
 * @param {string} sessionId
 * @returns {Store}
 */
export function removeOverlay(sessionId) {
  const store = loadStore();
  if (sessionId in store.overlay) {
    delete store.overlay[sessionId];
    writeStore(store);
  }
  return store;
}

/**
 * Ensure a session has an overlay entry; if missing, place it in the first
 * column (lowest `order`). A new card always starts in the first column.
 * @param {string} sessionId
 * @returns {Store}
 */
export function ensurePlaced(sessionId) {
  const store = loadStore();
  if (store.overlay[sessionId]) {
    return store;
  }

  const first = store.columns[0];
  store.overlay[sessionId] = {
    columnId: first ? first.id : '',
    order: 0,
    archived: false,
    lastDoneActivity: null,
  };

  writeStore(store);
  return store;
}

/**
 * Place many sessions at once: a single load + (at most) a single atomic write,
 * regardless of how many ids are new. Sessions that already have an overlay
 * entry are left untouched. This is the bulk equivalent of calling ensurePlaced
 * in a loop, but avoids the O(N) read+write+rename cost on first board load.
 * @param {Iterable<string>} sessionIds
 * @returns {Store}
 */
export function batchEnsurePlaced(sessionIds) {
  const store = loadStore();
  const first = store.columns[0];
  let changed = false;
  for (const sessionId of sessionIds) {
    if (store.overlay[sessionId]) continue;
    store.overlay[sessionId] = {
      columnId: first ? first.id : '',
      order: 0,
      archived: false,
      lastDoneActivity: null,
    };
    changed = true;
  }
  if (changed) writeStore(store);
  return store;
}

/**
 * Add a new column at the end of the board. The id is a stable slug of the name
 * plus the persisted incrementing counter.
 * @param {string} name
 * @returns {Column} The created column.
 */
export function addColumn(name) {
  const store = loadStore();
  const counter = store.nextColumnId;
  store.nextColumnId = counter + 1;

  const order = store.columns.length;
  const column = {
    id: `${slugify(name)}-${counter}`,
    name: String(name ?? '').trim() || `Colonna ${counter}`,
    color: COLUMN_COLORS[order % COLUMN_COLORS.length],
    order,
  };
  store.columns.push(column);

  writeStore(store);
  return column;
}

/**
 * Rename a column. The id is intentionally left unchanged so overlay entries
 * keep pointing at it. Throws if the column does not exist.
 * @param {string} id
 * @param {string} name
 * @returns {Store}
 */
export function renameColumn(id, name) {
  const store = loadStore();
  const column = findColumn(store, id);
  if (!column) {
    throw new Error(`unknown column: ${id}`);
  }
  column.name = String(name ?? '').trim() || column.name;

  writeStore(store);
  return store;
}

/**
 * Reorder columns to match the given id order. Any ids omitted from the list
 * keep their relative order and are appended after the provided ones. Unknown
 * ids in the input are ignored.
 * @param {string[]} idsInOrder
 * @returns {Store}
 */
export function reorderColumns(idsInOrder) {
  const store = loadStore();
  const byId = new Map(store.columns.map((c) => [c.id, c]));

  const ordered = [];
  const seen = new Set();
  for (const id of idsInOrder ?? []) {
    const col = byId.get(id);
    if (col && !seen.has(id)) {
      ordered.push(col);
      seen.add(id);
    }
  }
  // Append any columns not mentioned, preserving their existing order.
  for (const col of store.columns) {
    if (!seen.has(col.id)) ordered.push(col);
  }

  ordered.forEach((col, i) => {
    col.order = i;
  });
  store.columns = ordered;

  writeStore(store);
  return store;
}

/**
 * Delete a column, first moving its cards to another column. The target column
 * must exist and differ from the one being deleted. Cards moved to the target
 * are appended after any cards already there. Remaining columns are re-ordered
 * to keep `order` contiguous.
 * @param {string} id
 * @param {string} moveCardsToColumnId
 * @returns {Store}
 */
export function deleteColumn(id, moveCardsToColumnId) {
  const store = loadStore();

  const target = findColumn(store, id);
  if (!target) {
    throw new Error(`unknown column: ${id}`);
  }
  if (id === moveCardsToColumnId) {
    throw new Error('cannot move cards to the column being deleted');
  }
  if (!findColumn(store, moveCardsToColumnId)) {
    throw new Error(`unknown target column: ${moveCardsToColumnId}`);
  }

  // Compute the next free order in the destination so moved cards land after
  // existing ones.
  let nextOrder = 0;
  for (const entry of Object.values(store.overlay)) {
    if (entry.columnId === moveCardsToColumnId) {
      nextOrder = Math.max(nextOrder, entry.order + 1);
    }
  }

  // Reassign every card from the deleted column to the destination.
  const moving = Object.values(store.overlay)
    .filter((e) => e.columnId === id)
    .sort((a, b) => a.order - b.order);
  for (const entry of moving) {
    entry.columnId = moveCardsToColumnId;
    entry.order = nextOrder++;
  }

  // Drop the column and keep `order` contiguous.
  store.columns = store.columns.filter((c) => c.id !== id);
  store.columns.forEach((col, i) => {
    col.order = i;
  });

  writeStore(store);
  return store;
}
