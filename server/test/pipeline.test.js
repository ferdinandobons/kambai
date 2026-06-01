// pipeline.test.js — node --test, Node built-ins only (plus fastify, which the
// routes already depend on). Covers the review fixes that span more than one
// module:
//
//   1. watcher -> SSE pipeline: create/modify/delete a real <uuid>.jsonl under a
//      temp projects dir and assert startSessionWatcher emits session.added
//      (+ store.changed), session.updated, and session.removed.
//   2. GET /api/sessions reconciliation: an orphan overlay id is pruned after a
//      scan, and getBoard() exposes the derived doneColumnId.
//   3. doneColumnId export, POST /api/columns/reorder 400 on unknown ids, and
//      DELETE /api/sessions/:id 500 (generic, no path leak) on a non-ENOENT
//      unlink failure.
//
// IMPORTANT: config.js resolves CLAUDE_PROJECTS_DIR and STORE_PATH from the
// environment at IMPORT time. We therefore set KAMBAI_PROJECTS_DIR and
// KAMBAI_STORE_PATH BEFORE importing any server module, and import those modules
// dynamically below so they bind to our temp paths. `node --test` runs each test
// file in its own child process, so these env writes never leak into the other
// suites.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

// --- Temp dirs + env, set BEFORE importing the server modules ---------------
const baseTmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kambai-pipeline-'));
const projectsDir = path.join(baseTmp, 'projects');
const projectDir = path.join(projectsDir, '-Users-test-demo'); // encoded cwd
const storePath = path.join(baseTmp, 'store.json');
fsSync.mkdirSync(projectDir, { recursive: true });

process.env.KAMBAI_PROJECTS_DIR = projectsDir;
process.env.KAMBAI_STORE_PATH = storePath;

// Dynamic imports bind to the env above (config reads it at import time).
const { startSessionWatcher } = await import('../src/watcher.js');
const store = await import('../src/store.js');
const config = await import('../src/config.js');
const fsp = (await import('node:fs/promises')).default; // same singleton routes.js holds
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.js');

// Sanity: the modules really resolved against our temp projects dir.
assert.equal(config.CLAUDE_PROJECTS_DIR, path.resolve(projectsDir));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `cond` until true or timeout. Throws on timeout. (Mirrors wiring.test.js.)
 * @param {() => boolean} cond
 * @param {number} timeoutMs
 */
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(50);
  }
}

/** A minimal-but-parseable session line. */
const USER_LINE =
  '{"type":"user","cwd":"/Users/test/demo","timestamp":"2026-01-01T00:00:00.000Z",' +
  '"message":{"role":"user","content":"hello world"}}\n';
const ASSISTANT_LINE =
  '{"type":"assistant","timestamp":"2026-01-01T00:01:00.000Z",' +
  '"message":{"role":"assistant","model":"claude-x","content":[{"type":"text","text":"hi"}],' +
  '"usage":{"input_tokens":10}}}\n';

after(async () => {
  await fs.rm(baseTmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. watcher -> SSE pipeline
// ---------------------------------------------------------------------------

test('watcher pipeline: add/modify/delete emit session.added (+store.changed), updated, removed', {
  timeout: 20000,
}, async () => {
  // Reset the store to defaults for this run.
  await fs.rm(storePath, { force: true });
  store.loadStore();

  /** @type {Array<{type:string,session?:object,id?:string,store?:object}>} */
  const events = [];
  const handle = startSessionWatcher((evt) => events.push(evt));

  // Let chokidar finish its initial (ignored) scan.
  await delay(500);

  const id = '11111111-2222-4333-8444-555555555555';
  const file = path.join(projectDir, `${id}.jsonl`);

  try {
    // --- add ---
    await fs.writeFile(file, USER_LINE);
    await waitFor(() => events.some((e) => e.type === 'session.added'), 12000);

    const added = events.find((e) => e.type === 'session.added');
    assert.equal(added.session.id, id);
    // ensurePlaced ran and a store.changed followed so clients converge.
    assert.ok(
      events.some((e) => e.type === 'store.changed'),
      'expected a store.changed after the add',
    );
    assert.ok(id in store.loadStore().overlay, 'overlay entry created by ensurePlaced');

    // --- modify ---
    events.length = 0;
    await fs.appendFile(file, ASSISTANT_LINE);
    await waitFor(() => events.some((e) => e.type === 'session.updated'), 12000);
    const updated = events.find((e) => e.type === 'session.updated');
    assert.equal(updated.session.id, id);

    // --- delete ---
    events.length = 0;
    await fs.rm(file);
    await waitFor(() => events.some((e) => e.type === 'session.removed'), 12000);
    const removed = events.find((e) => e.type === 'session.removed');
    assert.equal(removed.id, id);
    // The out-of-band unlink drops the overlay entry and broadcasts the store.
    assert.equal(id in store.loadStore().overlay, false, 'overlay pruned on unlink');
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// 2. GET /api/sessions reconciliation + doneColumnId on the board
// ---------------------------------------------------------------------------

test('GET /api/sessions prunes an orphan overlay id and exposes doneColumnId', async () => {
  // Fresh store, fresh projects dir contents.
  await fs.rm(storePath, { force: true });
  for (const entry of await fs.readdir(projectDir)) {
    await fs.rm(path.join(projectDir, entry), { force: true });
  }

  // One real session on disk.
  const liveId = '22222222-3333-4444-8555-666666666666';
  await fs.writeFile(path.join(projectDir, `${liveId}.jsonl`), USER_LINE + ASSISTANT_LINE);

  // Seed an overlay entry whose .jsonl does NOT exist → an orphan.
  const orphanId = '99999999-8888-4777-8666-555555555555';
  store.ensurePlaced(orphanId);
  store.ensurePlaced(liveId);
  assert.ok(orphanId in store.loadStore().overlay, 'precondition: orphan present');

  const app = Fastify();
  await app.register(registerRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // The live session is returned; the orphan is gone from the persisted store.
    assert.ok(body.sessions.some((s) => s.id === liveId));
    assert.equal(orphanId in store.loadStore().overlay, false, 'orphan pruned after scan');
    assert.ok(liveId in store.loadStore().overlay, 'live session retained');
  } finally {
    await app.close();
  }

  // getBoard exposes the derived doneColumnId (highest-order column).
  const board = store.getBoard();
  const expectedDone = board.columns[board.columns.length - 1].id;
  assert.equal(board.doneColumnId, expectedDone);
  assert.equal(board.doneColumnId, store.doneColumnId(board));
});

// ---------------------------------------------------------------------------
// 3a. doneColumnId is exported and tracks the highest-order column
// ---------------------------------------------------------------------------

test('store.doneColumnId is exported and returns the highest-order column id', async () => {
  await fs.rm(storePath, { force: true });
  const fresh = store.loadStore();
  assert.equal(typeof store.doneColumnId, 'function');
  assert.equal(store.doneColumnId(fresh), fresh.columns[2].id); // "Done" is last

  // Reorder so a different column is last → doneColumnId follows it.
  const ids = fresh.columns.map((c) => c.id);
  const reordered = store.reorderColumns([ids[2], ids[0], ids[1]]);
  assert.equal(store.doneColumnId(reordered), ids[1]);
  // And it is reflected on getBoard().
  assert.equal(store.getBoard().doneColumnId, ids[1]);

  // Null when there are no columns.
  assert.equal(store.doneColumnId({ columns: [] }), null);
});

// ---------------------------------------------------------------------------
// 3b. POST /api/columns/reorder rejects unknown ids with a structured 400
// ---------------------------------------------------------------------------

test('POST /api/columns/reorder returns 400 when any id is not a current column', async () => {
  await fs.rm(storePath, { force: true });
  const board = store.loadStore();
  const validIds = board.columns.map((c) => c.id);

  const app = Fastify();
  await app.register(registerRoutes);
  try {
    // An id that is not a current column → 400, store untouched.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/columns/reorder',
      payload: { ids: [validIds[0], 'no-such-column'] },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.parse(bad.body).error, /existing columns/);
    // Order is unchanged on disk.
    assert.deepEqual(
      store.loadStore().columns.map((c) => c.id),
      validIds,
    );

    // A valid subset still succeeds (omitted ids are appended by the store).
    const ok = await app.inject({
      method: 'POST',
      url: '/api/columns/reorder',
      payload: { ids: [validIds[2], validIds[0], validIds[1]] },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(
      JSON.parse(ok.body).columns.map((c) => c.id),
      [validIds[2], validIds[0], validIds[1]],
    );
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3c. DELETE /api/sessions/:id replies a generic 500 (no path/OS text) on a
//     non-ENOENT unlink failure.
// ---------------------------------------------------------------------------

test('DELETE /api/sessions/:id returns a generic 500 (no path leak) on a non-ENOENT unlink error', async () => {
  await fs.rm(storePath, { force: true });
  // Clean the projects dir, then drop a single real session file so
  // resolveSessionFile finds it and we reach the unlink call.
  for (const entry of await fs.readdir(projectDir)) {
    await fs.rm(path.join(projectDir, entry), { force: true });
  }
  const id = '33333333-4444-4555-8666-777777777777';
  const file = path.join(projectDir, `${id}.jsonl`);
  await fs.writeFile(file, USER_LINE);

  // Force unlink to fail with a non-ENOENT error. routes.js does
  // `import fs from 'node:fs/promises'`; the default export is the cached module
  // singleton, so mocking it here also intercepts the route's call. Only unlink
  // is mocked, so realpath/readdir/stat in resolveSessionFile still work.
  const mocked = mock.method(fsp, 'unlink', async () => {
    const err = new Error(`EACCES: permission denied, unlink '${file}'`);
    err.code = 'EACCES';
    throw err;
  });

  const app = Fastify();
  await app.register(registerRoutes);
  try {
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { error: 'failed to delete session' });
    // The OS message and absolute path must NOT leak into the response.
    assert.ok(!res.body.includes(file), 'response must not contain the absolute path');
    assert.ok(!/EACCES/.test(res.body), 'response must not contain the OS error code');
    // The file was not actually removed (the unlink was mocked to fail).
    assert.equal(fsSync.existsSync(file), true);
  } finally {
    mocked.mock.restore();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3d. The global error handler turns an UNHANDLED route throw (a store write
//     that fails) into a fixed, detail-free 500 — no OS message, no absolute
//     path. store.js does `import fs from 'node:fs'`; the default export is the
//     same cached singleton as fsSync here, so mocking renameSync intercepts the
//     atomic write inside addColumn and forces the throw to propagate out of the
//     route to the handler.
// ---------------------------------------------------------------------------

test('error handler: a failed store write yields a generic 500 with no path/OS detail', async () => {
  await fs.rm(storePath, { force: true });
  store.loadStore(); // seed defaults so addColumn's loadStore() does not re-create

  // The leaky message a real EACCES rename would carry: an OS code plus the
  // absolute tmp path under the store dir. Neither may appear in the response.
  const leak = `EACCES: permission denied, rename '${storePath}.tmp' -> '${storePath}'`;
  const mocked = mock.method(fsSync, 'renameSync', () => {
    const err = new Error(leak);
    err.code = 'EACCES';
    err.path = `${storePath}.tmp`;
    throw err;
  });

  const app = Fastify();
  await app.register(registerRoutes);
  try {
    // POST /api/columns reaches store.addColumn → writeStore → renameSync (mocked
    // to throw). The route does not catch it, so the global handler must.
    const res = await app.inject({
      method: 'POST',
      url: '/api/columns',
      payload: { name: 'Boom' },
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'internal server error' });
    // No filesystem/OS detail of any kind leaks into the body.
    assert.ok(!res.body.includes(storePath), 'response must not contain the store path');
    assert.ok(!res.body.includes(`${storePath}.tmp`), 'response must not contain the tmp path');
    assert.ok(!/EACCES/.test(res.body), 'response must not contain the OS error code');
    assert.ok(!res.body.includes('rename'), 'response must not contain the syscall name');
  } finally {
    mocked.mock.restore();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3e. POST /api/columns/reorder with an EMPTY ids array behaves sanely: it is a
//     valid (string[]) body, so it is accepted, and reorderColumns leaves the
//     existing order intact (every column is simply "omitted" and appended in
//     its current order). The board must not be corrupted.
// ---------------------------------------------------------------------------

test('POST /api/columns/reorder with an empty ids array is a no-op and does not corrupt order', async () => {
  await fs.rm(storePath, { force: true });
  const board = store.loadStore();
  const before = board.columns.map((c) => c.id);

  const app = Fastify();
  await app.register(registerRoutes);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/columns/reorder',
      payload: { ids: [] },
    });
    assert.equal(res.statusCode, 200);
    // Order is preserved exactly (and orders stay contiguous 0..n-1).
    const after = JSON.parse(res.body).columns;
    assert.deepEqual(after.map((c) => c.id), before);
    assert.deepEqual(after.map((c) => c.order), before.map((_, i) => i));
    // And the same is true of the persisted store.
    assert.deepEqual(store.loadStore().columns.map((c) => c.id), before);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3f. setTitle reset-to-blank on an entry whose customTitle is ALREADY null does
//     not perform a disk write (the value is unchanged). We count writeFileSync
//     calls around the no-op to prove the atomic write was skipped.
// ---------------------------------------------------------------------------

test('setTitle reset no-op does not write when the title is already blank', async () => {
  await fs.rm(storePath, { force: true });
  store.loadStore();
  // Create an overlay entry whose customTitle is null (ensurePlaced sets it so).
  const id = '44444444-5555-4666-8777-888888888888';
  store.ensurePlaced(id);
  assert.equal(store.loadStore().overlay[id].customTitle, null);

  // Now count atomic writes (writeStore → writeFileSync) across a blank reset.
  const writeSpy = mock.method(fsSync, 'writeFileSync', () => {});
  try {
    const after = store.setTitle(id, '   '); // whitespace → normalized null → no change
    assert.equal(writeSpy.mock.callCount(), 0, 'setTitle must not write when unchanged');
    // The returned store still reflects the (unchanged) null title.
    assert.equal(after.overlay[id].customTitle, null);
  } finally {
    writeSpy.mock.restore();
  }

  // A genuine change DOES write (one writeFileSync for the tmp file).
  const writeSpy2 = mock.method(fsSync, 'writeFileSync', fsSync.writeFileSync);
  try {
    store.setTitle(id, 'Real title');
    assert.ok(writeSpy2.mock.callCount() >= 1, 'a real title change must write');
  } finally {
    writeSpy2.mock.restore();
  }
  assert.equal(store.loadStore().overlay[id].customTitle, 'Real title');
});
