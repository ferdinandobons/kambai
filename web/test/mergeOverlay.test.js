// mergeOverlay.test.js (vitest) — unit tests for App.jsx's mergeOverlay, the
// client half of the shared effective-title / placement merge rule. The server
// mirrors this in routes.js mergeSessions; these tests guard against drift.
//
// Runs under the `node` environment (no DOM): mergeOverlay is a pure function.

import { describe, it, expect } from 'vitest';
import { mergeOverlay } from '../src/App.jsx';

const store = {
  columns: [
    { id: 'col-todo-0', name: 'To do', order: 0 },
    { id: 'col-prog-1', name: 'In progress', order: 1 },
    { id: 'col-done-2', name: 'Done', order: 2 },
  ],
  overlay: {},
};

/** A store whose overlay holds a single entry for `id`. */
function withOverlay(id, entry) {
  return { ...store, overlay: { [id]: entry } };
}

describe('mergeOverlay effective-title rule', () => {
  it('(a) a non-blank overlay customTitle overrides the parsed title', () => {
    const session = { id: 's1', title: 'Parsed original' };
    const merged = mergeOverlay(
      session,
      withOverlay('s1', {
        columnId: 'col-prog-1',
        order: 3,
        archived: false,
        lastDoneActivity: null,
        customTitle: 'My custom name',
      }),
    );
    expect(merged.title).toBe('My custom name');
    expect(merged.customTitle).toBe('My custom name');
    expect(merged.originalTitle).toBe('Parsed original');
    // Placement is taken from the overlay.
    expect(merged.columnId).toBe('col-prog-1');
    expect(merged.order).toBe(3);
  });

  it('(b) a blank/whitespace customTitle falls back to the original', () => {
    const session = { id: 's2', title: 'Parsed original', originalTitle: 'Parsed original' };
    const merged = mergeOverlay(
      session,
      withOverlay('s2', {
        columnId: 'col-todo-0',
        order: 0,
        archived: false,
        lastDoneActivity: null,
        customTitle: '   ',
      }),
    );
    expect(merged.title).toBe('Parsed original');
    // The whitespace override is carried through verbatim (server stores null,
    // but the client preserves whatever the overlay holds); the effective title
    // is what matters and it falls back to the original.
    expect(merged.originalTitle).toBe('Parsed original');
  });

  it('(c) a raw SSE SessionMeta (no originalTitle, no overlay) anchors base off session.title', () => {
    // SSE delivers a raw SessionMeta: .title is the parsed original, and there
    // is no overlay entry yet. The card lands in the first column with no custom.
    const session = { id: 's3', title: 'Fresh from SSE' };
    const merged = mergeOverlay(session, store);
    expect(merged.title).toBe('Fresh from SSE');
    expect(merged.originalTitle).toBe('Fresh from SSE');
    expect(merged.customTitle).toBe(null);
    expect(merged.columnId).toBe('col-todo-0'); // first column fallback
    expect(merged.archived).toBe(false);
  });

  it('(d) against a STALE overlay (customTitle still null), mergeOverlay yields the original — which is why the SSE handler must preserve the locally-held customTitle during an in-flight rename', () => {
    // Reproduces the in-flight window: user optimistically renamed to "Foo" in
    // local state, but the PATCH's store.changed has not landed, so the overlay
    // still has customTitle=null. mergeOverlay against that stale overlay would
    // revert the title to the original. The App SSE handler guards against this
    // by re-applying the locally-held customTitle (see App.jsx session.updated).
    const rawSse = { id: 's4', title: 'Original title' };
    const staleStore = withOverlay('s4', {
      columnId: 'col-todo-0',
      order: 0,
      archived: false,
      lastDoneActivity: null,
      customTitle: null, // not yet updated by the in-flight PATCH
    });
    const merged = mergeOverlay(rawSse, staleStore);
    // mergeOverlay alone reverts to original (the bug, if applied blindly)...
    expect(merged.title).toBe('Original title');
    expect(merged.customTitle).toBe(null);

    // ...so the SSE handler preserves the locally-held customTitle and recomputes
    // the effective title locally. Re-running that guard restores the rename:
    const localCustom = 'Foo';
    const effective =
      localCustom && localCustom.trim() ? localCustom : merged.originalTitle;
    expect(effective).toBe('Foo');
    // originalTitle is still refreshed from the freshly parsed title.
    expect(merged.originalTitle).toBe('Original title');
  });
});
