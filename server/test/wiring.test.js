// wiring.test.js — unit tests for the SERVER WIRING layer (sse, watcher,
// routes guards). Runs with `node --test` using ONLY Node built-ins plus the
// already-declared deps (fastify, chokidar) that the modules under test import.
//
// These tests intentionally avoid depending on the still-stubbed
// sessionParser/scanner/store implementations: they exercise the parts of the
// wiring that are self-contained (the SSE hub, the chokidar watcher, and the
// route-level input guards that reject before any store/scanner call).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { addClient, broadcast, clientCount, closeAll } from '../src/sse.js';
import { startWatcher, sessionIdFromPath } from '../src/watcher.js';
import { CLAUDE_PROJECTS_DIR } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fake Fastify reply whose `.raw` is a fake ServerResponse capturing writes
 * and emitting 'close' on demand, so we can drive the SSE hub without sockets.
 */
function makeFakeReply() {
  const raw = new EventEmitter();
  const chunks = [];
  raw.writeHead = (status, headers) => {
    raw._status = status;
    raw._headers = headers;
    return raw;
  };
  raw.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  raw.end = () => {
    raw.emit('close');
  };
  return { raw, chunks };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SSE hub
// ---------------------------------------------------------------------------

test('sse: addClient sets SSE headers and writes the connect preamble', () => {
  const { raw, chunks } = makeFakeReply();
  addClient({ raw });

  assert.equal(raw._status, 200);
  assert.equal(raw._headers['Content-Type'], 'text/event-stream');
  assert.match(raw._headers['Cache-Control'], /no-cache/);
  assert.equal(raw._headers.Connection, 'keep-alive');
  assert.ok(chunks.join('').includes(': connected'));
  assert.equal(clientCount(), 1);

  closeAll();
  assert.equal(clientCount(), 0);
});

test('sse: broadcast serializes the event as JSON in a data: frame', () => {
  const { raw, chunks } = makeFakeReply();
  addClient({ raw });
  chunks.length = 0; // drop the preamble

  broadcast({ type: 'session.added', session: { id: 'abc', title: 'Hi' } });

  const out = chunks.join('');
  assert.ok(out.startsWith('data: '));
  assert.ok(out.endsWith('\n\n'));
  const json = JSON.parse(out.slice('data: '.length).trim());
  assert.deepEqual(json, { type: 'session.added', session: { id: 'abc', title: 'Hi' } });

  closeAll();
});

test('sse: broadcasts reach every connected client', () => {
  const a = makeFakeReply();
  const b = makeFakeReply();
  addClient({ raw: a.raw });
  addClient({ raw: b.raw });
  a.chunks.length = 0;
  b.chunks.length = 0;

  broadcast({ type: 'store.changed', store: { version: 1 } });

  assert.ok(a.chunks.join('').includes('store.changed'));
  assert.ok(b.chunks.join('').includes('store.changed'));

  closeAll();
});

test('sse: a disconnected client is pruned and no longer receives events', () => {
  const { raw, chunks } = makeFakeReply();
  addClient({ raw });
  assert.equal(clientCount(), 1);

  raw.emit('close'); // simulate disconnect
  assert.equal(clientCount(), 0);

  chunks.length = 0;
  broadcast({ type: 'session.removed', id: 'gone' });
  assert.equal(chunks.length, 0); // nothing written after disconnect

  closeAll();
});

// ---------------------------------------------------------------------------
// watcher: sessionIdFromPath
// ---------------------------------------------------------------------------

test('watcher: sessionIdFromPath strips the directory and .jsonl extension', () => {
  assert.equal(
    sessionIdFromPath('/Users/x/.claude/projects/-foo/11111111-2222-4333-8444-555555555555.jsonl'),
    '11111111-2222-4333-8444-555555555555'
  );
});

// ---------------------------------------------------------------------------
// watcher: chokidar add/change/unlink with debounce.
//
// chokidar watches CLAUDE_PROJECTS_DIR (from config). We create a real temp
// project dir *inside* CLAUDE_PROJECTS_DIR so the relative-path watch resolves,
// and clean it up afterwards. If the projects dir cannot be created (locked-down
// CI), the test is skipped rather than failing.
// ---------------------------------------------------------------------------

let tmpProjectDir;
let projectsDirCreated = false;

before(async () => {
  try {
    await fs.mkdir(CLAUDE_PROJECTS_DIR, { recursive: true });
    projectsDirCreated = true;
    tmpProjectDir = await fs.mkdtemp(path.join(CLAUDE_PROJECTS_DIR, 'kambai-test-'));
  } catch {
    projectsDirCreated = false;
  }
});

after(async () => {
  if (tmpProjectDir) {
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  }
});

test('watcher: fires onAdd/onChange/onUnlink (debounced) for .jsonl files', { timeout: 15000 }, async (t) => {
  if (!projectsDirCreated || !tmpProjectDir) {
    t.skip('cannot create CLAUDE_PROJECTS_DIR in this environment');
    return;
  }

  const events = { add: [], change: [], unlink: [] };
  const handle = startWatcher({
    onAdd: (p) => events.add.push(p),
    onChange: (p) => events.change.push(p),
    onUnlink: (p) => events.unlink.push(p),
  });

  // Give chokidar a moment to set up its initial scan (ignoreInitial: true).
  await delay(400);

  const id = '11111111-2222-4333-8444-555555555555';
  const file = path.join(tmpProjectDir, `${id}.jsonl`);

  // add
  await fs.writeFile(file, '{"type":"user"}\n');
  await waitFor(() => events.add.length >= 1, 8000);
  assert.equal(sessionIdFromPath(events.add[0]), id);
  assert.equal(path.resolve(events.add[0]), path.resolve(file));

  // change (multiple rapid writes should debounce; we only assert >=1)
  await fs.appendFile(file, '{"type":"assistant"}\n');
  await fs.appendFile(file, '{"type":"assistant"}\n');
  await waitFor(() => events.change.length >= 1, 8000);

  // unlink
  await fs.rm(file);
  await waitFor(() => events.unlink.length >= 1, 8000);
  assert.equal(sessionIdFromPath(events.unlink[0]), id);

  await handle.close();
});

/**
 * Poll `cond` until true or timeout. Throws on timeout.
 * @param {() => boolean} cond
 * @param {number} timeoutMs
 */
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await delay(50);
  }
}

// ---------------------------------------------------------------------------
// routes: input guards that reject before touching store/scanner stubs.
// We mount the routes on a real Fastify instance and use app.inject (no socket,
// no listen). DELETE with a non-UUID id returns 400 before any scanner call.
// ---------------------------------------------------------------------------

test('routes: DELETE /api/sessions/:id rejects a non-UUID id with 400', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes.js');

  const app = Fastify();
  await app.register(registerRoutes);

  for (const bad of ['not-a-uuid', '../etc/passwd', '12345', '11111111-2222-1333-8444-555555555555']) {
    // The last one has version nibble 1 (not 4) → still invalid v4.
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${encodeURIComponent(bad)}` });
    assert.equal(res.statusCode, 400, `expected 400 for id="${bad}"`);
  }

  await app.close();
});

test('routes: POST /api/cards/:id/move validates body before mutating', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes.js');

  const app = Fastify();
  await app.register(registerRoutes);

  // Missing columnId/order → 400 (never reaches the store stub).
  const res = await app.inject({
    method: 'POST',
    url: '/api/cards/anything/move',
    payload: {},
  });
  assert.equal(res.statusCode, 400);

  await app.close();
});

test('routes: POST /api/columns rejects empty name with 400', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes.js');

  const app = Fastify();
  await app.register(registerRoutes);

  const res = await app.inject({ method: 'POST', url: '/api/columns', payload: { name: '   ' } });
  assert.equal(res.statusCode, 400);

  await app.close();
});
