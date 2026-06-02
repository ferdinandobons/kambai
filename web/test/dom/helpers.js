// helpers.js — shared fixtures + a controllable fake SSE emitter for the App
// integration tests. NOT a *.test file, so vitest never collects it as a suite.

import { vi } from 'vitest';

/** The default three-column board the server ships with. */
export const COLUMNS = [
  { id: 'col-todo-0', name: 'To do', color: '#888', order: 0 },
  { id: 'col-prog-1', name: 'In progress', color: '#39f', order: 1 },
  { id: 'col-done-2', name: 'Done', color: '#3a3', order: 2 },
];

export const DONE_COL = 'col-done-2';

/**
 * Build a raw SessionMeta as the server's /api/sessions and SSE session.updated
 * deliver it. `.title` is the parsed original; overlay fields are layered in by
 * mergeOverlay on the client.
 */
export function makeSession(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Parsed original title',
    originalTitle: 'Parsed original title',
    projectName: 'kanbai',
    projectDir: 'kanbai',
    projectPath: '/Users/me/kanbai',
    gitBranch: 'main',
    model: 'claude-opus-4-8',
    contextPct: 42,
    contextTokens: 12345,
    messageCount: 7,
    lastActivity: '2026-06-01T10:00:00.000Z',
    createdAt: '2026-05-30T09:00:00.000Z',
    lastPrompt: 'do the thing',
    order: 0,
    ...overrides,
  };
}

/** A full store snapshot (columns + overlay) as getBoard()/store.changed carry. */
export function makeStore(overlay = {}, columns = COLUMNS) {
  return { columns, overlay, doneColumnId: DONE_COL };
}

/**
 * A controllable fake of api.subscribe: instead of a real EventSource, it hands
 * back the App's onEvent callback so a test can push events synchronously via
 * emit(...). Tracks unsubscribe so the test can assert teardown.
 */
export function makeFakeEmitter() {
  let handler = null;
  let unsubscribed = false;
  const subscribe = vi.fn((onEvent) => {
    handler = onEvent;
    return () => {
      unsubscribed = true;
    };
  });
  return {
    subscribe,
    /** Push one SSE event into the App. */
    emit(evt) {
      if (!handler) throw new Error('emit() called before subscribe()');
      handler(evt);
    },
    get unsubscribed() {
      return unsubscribed;
    },
    get hasHandler() {
      return handler != null;
    },
  };
}

/**
 * A Deferred lets a test hold a mocked api mutation "in flight" (its promise
 * unresolved) while it pushes a racing SSE event, then resolve it on demand.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
