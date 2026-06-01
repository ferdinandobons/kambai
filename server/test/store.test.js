// store.test.js — node --test, no test-framework deps (Node built-ins only).
//
// Every test points KAMBAI_STORE_PATH at a unique temporary file so the real
// data/store.json is never touched. store.js resolves its path per-operation,
// reading process.env.KAMBAI_STORE_PATH if set, else STORE_PATH from config.js.
//
// Run with: node --test  (from the server/ directory)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadStore,
  getBoard,
  moveCard,
  setArchived,
  removeOverlay,
  ensurePlaced,
  addColumn,
  renameColumn,
  reorderColumns,
  deleteColumn,
} from '../src/store.js';

let tmpDir;
let storePath;

beforeEach(() => {
  // A fresh temp dir + path per test → full isolation, never touches data/store.json.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kambai-store-'));
  storePath = path.join(tmpDir, 'store.json');
  process.env.KAMBAI_STORE_PATH = storePath;
});

afterEach(() => {
  delete process.env.KAMBAI_STORE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadStore creates defaults on first run and persists them', () => {
  const store = loadStore();
  assert.equal(store.version, 1);
  assert.deepEqual(
    store.columns.map((c) => c.name),
    ['To do', 'In progress', 'Done'],
  );
  assert.deepEqual(
    store.columns.map((c) => c.order),
    [0, 1, 2],
  );
  // Every default column has a stable, deterministic, non-random id.
  for (const col of store.columns) {
    assert.match(col.id, /^[a-z0-9-]+-\d+$/);
  }
  assert.deepEqual(store.overlay, {});
  // File was written to the temp path.
  assert.ok(fs.existsSync(storePath));
});

test('getBoard returns a deep copy that does not mutate the stored state', () => {
  loadStore();
  const board = getBoard();
  board.columns[0].name = 'MUTATED';
  board.overlay['ghost'] = { columnId: 'x', order: 0, archived: false, lastDoneActivity: null };
  const fresh = getBoard();
  assert.equal(fresh.columns[0].name, 'To do');
  assert.equal('ghost' in fresh.overlay, false);
});

test('moveCard places a card in a column at an order', () => {
  const store = loadStore();
  const colId = store.columns[1].id;
  const after = moveCard('sess-1', colId, 3);
  assert.deepEqual(after.overlay['sess-1'], {
    columnId: colId,
    order: 3,
    archived: false,
    lastDoneActivity: null,
  });
  // Re-load from disk to prove it was persisted.
  const reloaded = loadStore();
  assert.equal(reloaded.overlay['sess-1'].columnId, colId);
  assert.equal(reloaded.overlay['sess-1'].order, 3);
});

test('moveCard preserves archived flag when moving an existing card', () => {
  const store = loadStore();
  const a = store.columns[0].id;
  const b = store.columns[2].id;
  moveCard('s', a, 0);
  setArchived('s', true);
  const after = moveCard('s', b, 1);
  assert.equal(after.overlay['s'].archived, true);
  assert.equal(after.overlay['s'].columnId, b);
});

test('moveCard throws for an unknown column', () => {
  loadStore();
  assert.throws(() => moveCard('s', 'no-such-col', 0), /unknown column/);
});

test('setArchived toggles archived (and creates an entry if missing)', () => {
  loadStore();
  const created = setArchived('s', true);
  assert.equal(created.overlay['s'].archived, true);
  // Placed in the first column when no entry existed.
  assert.equal(created.overlay['s'].columnId, created.columns[0].id);

  const off = setArchived('s', false);
  assert.equal(off.overlay['s'].archived, false);
});

test('removeOverlay drops the overlay entry', () => {
  const store = loadStore();
  moveCard('s', store.columns[0].id, 0);
  assert.ok('s' in loadStore().overlay);
  removeOverlay('s');
  assert.equal('s' in loadStore().overlay, false);
});

test('ensurePlaced puts new sessions in the first column and is idempotent', () => {
  const store = loadStore();
  const firstColId = store.columns[0].id;

  const placed = ensurePlaced('new-sess');
  assert.equal(placed.overlay['new-sess'].columnId, firstColId);
  assert.equal(placed.overlay['new-sess'].order, 0);
  assert.equal(placed.overlay['new-sess'].archived, false);

  // Move it elsewhere, then ensurePlaced must NOT move it back.
  const lastColId = store.columns[2].id;
  moveCard('new-sess', lastColId, 5);
  const again = ensurePlaced('new-sess');
  assert.equal(again.overlay['new-sess'].columnId, lastColId);
  assert.equal(again.overlay['new-sess'].order, 5);
});

test('addColumn appends a column with a stable slug+counter id', () => {
  loadStore();
  const col = addColumn('In Review');
  assert.equal(col.name, 'In Review');
  assert.equal(col.order, 3);
  assert.match(col.id, /^in-review-\d+$/);

  // The counter increments and is persisted (ids never collide / repeat).
  const col2 = addColumn('In Review');
  assert.notEqual(col2.id, col.id);
  assert.match(col2.id, /^in-review-\d+$/);

  const store = loadStore();
  assert.equal(store.columns.length, 5);
});

test('renameColumn changes the name but keeps the id stable', () => {
  loadStore();
  const col = addColumn('Backlog');
  const before = col.id;
  const store = renameColumn(col.id, 'Icebox');
  const renamed = store.columns.find((c) => c.id === before);
  assert.equal(renamed.name, 'Icebox');
  assert.equal(renamed.id, before); // overlay entries keep pointing at it
  assert.throws(() => renameColumn('nope', 'x'), /unknown column/);
});

test('reorderColumns reorders by id and appends omitted columns', () => {
  const store = loadStore();
  const [a, b, c] = store.columns.map((col) => col.id);
  const after = reorderColumns([c, a]); // b omitted → appended last
  assert.deepEqual(
    after.columns.map((col) => col.id),
    [c, a, b],
  );
  assert.deepEqual(
    after.columns.map((col) => col.order),
    [0, 1, 2],
  );
});

test('deleteColumn moves its cards to the target then removes the column', () => {
  const store = loadStore();
  const [a, b, c] = store.columns.map((col) => col.id);

  // Two cards in column A, one already in column B.
  moveCard('s1', a, 0);
  moveCard('s2', a, 1);
  moveCard('s3', b, 0);

  const after = deleteColumn(a, b);

  // Column A is gone; orders are contiguous.
  assert.equal(after.columns.find((col) => col.id === a), undefined);
  assert.deepEqual(
    after.columns.map((col) => col.id),
    [b, c],
  );
  assert.deepEqual(
    after.columns.map((col) => col.order),
    [0, 1],
  );

  // s1/s2 moved to B, appended after the existing s3 (order 0).
  assert.equal(after.overlay['s1'].columnId, b);
  assert.equal(after.overlay['s2'].columnId, b);
  assert.equal(after.overlay['s3'].columnId, b);
  const ordersInB = ['s1', 's2', 's3']
    .map((id) => after.overlay[id].order)
    .sort((x, y) => x - y);
  assert.deepEqual(ordersInB, [0, 1, 2]); // unique, contiguous
});

test('deleteColumn rejects bad targets', () => {
  const store = loadStore();
  const a = store.columns[0].id;
  assert.throws(() => deleteColumn(a, a), /cannot move cards to the column being deleted/);
  assert.throws(() => deleteColumn(a, 'nope'), /unknown target column/);
  assert.throws(() => deleteColumn('nope', a), /unknown column/);
});

test('writes are atomic: no .tmp file is left behind after an operation', () => {
  loadStore();
  moveCard('s', loadStore().columns[0].id, 0);
  assert.equal(fs.existsSync(`${storePath}.tmp`), false);
  assert.ok(fs.existsSync(storePath));
  // The persisted file is valid JSON matching the in-memory store.
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(onDisk.overlay['s'].order, 0);
});

test('recovers from a corrupt store file: backs up to .bak and resets to defaults', () => {
  // Write garbage to the store path before any load.
  fs.writeFileSync(storePath, '{ this is not valid json ]]]', 'utf8');

  const store = loadStore();
  // Backed up the corrupt file.
  assert.ok(fs.existsSync(`${storePath}.bak`));
  assert.equal(fs.readFileSync(`${storePath}.bak`, 'utf8'), '{ this is not valid json ]]]');
  // Reset to defaults rather than throwing.
  assert.deepEqual(
    store.columns.map((c) => c.name),
    ['To do', 'In progress', 'Done'],
  );
  assert.deepEqual(store.overlay, {});
  // The new defaults were persisted (valid JSON on disk).
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(onDisk.version, 1);
});

test('recovers from a structurally invalid (but valid JSON) store', () => {
  // Valid JSON, wrong shape (columns is not an array).
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, columns: {}, overlay: {} }), 'utf8');
  const store = loadStore();
  assert.ok(fs.existsSync(`${storePath}.bak`));
  assert.equal(store.columns.length, 3);
});
