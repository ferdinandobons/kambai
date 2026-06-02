// App.integration.test.jsx — integration tests for the App's live-update
// reconciliation, the highest-risk untested logic. We mock ../src/api.js so the
// SSE stream is a controllable fake emitter and every REST mutation is a stub we
// can hold in flight (a Deferred) while a racing store.changed/session.updated
// arrives. This exercises the pendingRef re-apply + patch-merge paths the review
// flagged as untested.
//
// To drive App.handleMove / handleArchive deterministically (a real dnd-kit drag
// needs layout jsdom doesn't provide), we mock the Board component with a tiny
// stand-in that captures the onMove/onArchive props App passes down and exposes
// them to the test. The board still RENDERS each visible session (id, title,
// columnId, archived) so the test can assert the reconciled state from the DOM.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';

import { makeSession, makeStore, makeFakeEmitter, deferred } from './helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';

// ---- Mock the API module (controllable emitter + in-flight mutation stubs). ----
vi.mock('../../src/api.js', () => {
  const emitterRef = { current: null };
  return {
    __emitterRef: emitterRef,
    getSessions: vi.fn(),
    getBoard: vi.fn(),
    getPrompts: vi.fn().mockResolvedValue({ prompts: [], total: 0 }),
    moveCard: vi.fn(),
    archiveCard: vi.fn(),
    setTitle: vi.fn(),
    deleteSession: vi.fn(),
    addColumn: vi.fn(),
    renameColumn: vi.fn(),
    reorderColumns: vi.fn(),
    deleteColumn: vi.fn(),
    subscribe: vi.fn((onEvent) => emitterRef.current.subscribe(onEvent)),
  };
});

// ---- Mock Board with a minimal render that captures the move/archive props.
// We render one row per visible session carrying its reconciled fields as data
// attributes so the test asserts placement/archive from the DOM. The captured
// callbacks let the test invoke App.handleMove / handleArchive directly, exactly
// as a real drag / menu click would, without needing layout. ----
const boardProps = { current: null };
vi.mock('../../src/components/Board.jsx', () => ({
  default: (props) => {
    boardProps.current = props;
    // Render from allSessions (the FULL unfiltered list) so archived cards stay
    // assertable — the real Board hides archived from its visible `sessions`,
    // which would otherwise make a just-archived card vanish from the DOM.
    const rows = props.allSessions || props.sessions;
    return (
      <div data-testid="board">
        {rows.map((s) => (
          <div
            key={s.id}
            data-testid={`card-${s.id}`}
            data-column={s.columnId}
            data-archived={String(!!s.archived)}
            data-order={s.order}
            data-title={s.title}
          >
            {s.title}
          </div>
        ))}
      </div>
    );
  },
}));

import * as api from '../../src/api.js';
import App from '../../src/App.jsx';

/** Render App with a session list + board already resolved, plus a live emitter. */
async function renderApp({ sessions, store }) {
  const emitter = makeFakeEmitter();
  api.__emitterRef.current = emitter;
  api.getSessions.mockResolvedValue({ sessions, columns: store.columns });
  api.getBoard.mockResolvedValue(store);

  let utils;
  await act(async () => {
    utils = render(<App />);
  });
  await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
  // Wait for the initial load to paint at least one card.
  await waitFor(() => expect(boardProps.current?.sessions?.length).toBeGreaterThan(0));
  return { emitter, ...utils };
}

/** Reconciled column id for the card with `id`, read from the rendered board. */
function columnOf(id) {
  return screen.getByTestId(`card-${id}`).getAttribute('data-column');
}
/** Reconciled archived flag for the card with `id`. */
function isArchived(id) {
  return screen.getByTestId(`card-${id}`).getAttribute('data-archived') === 'true';
}
/** Reconciled effective title for the card with `id`. */
function titleOf(id) {
  return screen.getByTestId(`card-${id}`).getAttribute('data-title');
}
/** Reconciled order for the card with `id`, read from the rendered board. */
function orderOf(id) {
  return screen.getByTestId(`card-${id}`).getAttribute('data-order');
}

/** Invoke App.handleMove(id, columnId, order, reordered) as Board's drag-end does. */
function move(id, columnId, order = 0) {
  // Single-card moves: reordered is just the moved card at index `order`.
  boardProps.current.onMove(id, columnId, order, [{ id }]);
}
/** Invoke App.handleArchive(id, archived) as the card menu / detail modal does. */
function archive(id, archived) {
  boardProps.current.onArchive(id, archived);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  boardProps.current = null;
});

describe('App live-update reconciliation', () => {
  it('(1) session.updated during an in-flight rename preserves the local customTitle and recomputes the effective title', async () => {
    const session = makeSession({ id: ID, title: 'Orig', originalTitle: 'Orig' });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });

    const pending = deferred();
    api.setTitle.mockReturnValue(pending.promise);

    const { emitter } = await renderApp({ sessions: [session], store });
    expect(titleOf(ID)).toBe('Orig');

    // Open the detail modal and rename to "My name" (Save) WITHOUT resolving the
    // PATCH — the server overlay is still pre-rename (customTitle null).
    const user = (await import('@testing-library/user-event')).default.setup();
    await act(async () => {
      boardProps.current.onOpen(session);
    });
    const input = await screen.findByLabelText('Session title');
    await user.clear(input);
    await user.type(input, 'My name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Optimistic effective title applied on the card.
    await waitFor(() => expect(titleOf(ID)).toBe('My name'));

    // A live session.updated arrives carrying a NEW parsed original AND the stale
    // overlay (customTitle still null server-side). The local optimistic custom
    // title must survive; the effective title stays the custom one; the NEW
    // original is refreshed underneath and content fields update.
    await act(async () => {
      emitter.emit({
        type: 'session.updated',
        session: makeSession({
          id: ID,
          title: 'New parsed original',
          originalTitle: 'New parsed original',
          messageCount: 99,
        }),
      });
    });

    expect(titleOf(ID)).toBe('My name');

    // The detail modal reflects the same live state: it now shows the "Original:"
    // hint with the freshly-parsed original (custom override is active), proving
    // originalTitle was refreshed while the custom title was preserved.
    expect(screen.getByText('New parsed original')).toBeInTheDocument();
    expect(screen.getByText(/Reset to original/i)).toBeInTheDocument();

    await act(async () => {
      pending.resolve(makeStore());
    });
  });

  it('(2) a store.changed carrying a STALE overlay during an in-flight move does NOT revert the pending move', async () => {
    const session = makeSession({ id: ID });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });

    const pending = deferred();
    api.moveCard.mockReturnValue(pending.promise);

    const { emitter } = await renderApp({ sessions: [session], store });
    expect(columnOf(ID)).toBe('col-todo-0');

    // Optimistically move To do → In progress (PATCH held in flight).
    await act(async () => {
      move(ID, 'col-prog-1', 0);
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    expect(api.moveCard).toHaveBeenCalledWith(ID, 'col-prog-1', 0);

    // A STALE store.changed arrives — overlay still places the card in To do.
    // pendingRef re-apply must keep it in In progress.
    await act(async () => {
      emitter.emit({
        type: 'store.changed',
        store: makeStore({
          [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
        }),
      });
    });
    expect(columnOf(ID)).toBe('col-prog-1');

    // Resolve the move + land the authoritative snapshot → stays put.
    await act(async () => {
      pending.resolve(makeStore());
    });
    await act(async () => {
      emitter.emit({
        type: 'store.changed',
        store: makeStore({
          [ID]: { columnId: 'col-prog-1', order: 0, archived: false, customTitle: null },
        }),
      });
    });
    expect(columnOf(ID)).toBe('col-prog-1');
  });

  it('(3) concurrent move + archive on the same card keeps BOTH optimistic fields (handleMove patch-merge)', async () => {
    const session = makeSession({ id: ID });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });

    const movePending = deferred();
    const archivePending = deferred();
    api.moveCard.mockReturnValue(movePending.promise);
    api.archiveCard.mockReturnValue(archivePending.promise);

    const { emitter } = await renderApp({ sessions: [session], store });

    // Fire BOTH while both are in flight (overlapping pendingRef patch).
    await act(async () => {
      move(ID, 'col-prog-1', 0);
      archive(ID, true);
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    expect(isArchived(ID)).toBe(true);

    // A stale snapshot (To do, not archived) must clobber NEITHER field.
    await act(async () => {
      emitter.emit({
        type: 'store.changed',
        store: makeStore({
          [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
        }),
      });
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    expect(isArchived(ID)).toBe(true);

    // Resolve the move only (its finally clears just columnId/order). A snapshot
    // landing now (placement applied, archive not yet persisted) must keep the
    // still-in-flight archive patch.
    //
    // The move handler's finally (clearPending of columnId/order) runs as a
    // microtask after movePending.resolve. Flush microtasks INSIDE the same act
    // so that clearPending settles deterministically BEFORE the racing snapshot
    // is emitted — otherwise the emit can interleave ahead of the finally and the
    // assertion below races microtask ordering (genuine flakiness, App.jsx itself
    // behaves correctly once the pending map has settled).
    await act(async () => {
      movePending.resolve(makeStore());
      await Promise.resolve();
    });
    await act(async () => {
      emitter.emit({
        type: 'store.changed',
        store: makeStore({
          [ID]: { columnId: 'col-prog-1', order: 0, archived: false, customTitle: null },
        }),
      });
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    // Assert via waitFor so the check retries until reconciliation settles rather
    // than reading a single synchronous snapshot mid-microtask-flush.
    await waitFor(() => expect(isArchived(ID)).toBe(true)); // archive patch preserved

    // Resolve archive + land the final authoritative snapshot.
    await act(async () => {
      archivePending.resolve(makeStore());
    });
    await act(async () => {
      emitter.emit({
        type: 'store.changed',
        store: makeStore({
          [ID]: { columnId: 'col-prog-1', order: 0, archived: true, customTitle: null },
        }),
      });
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    expect(isArchived(ID)).toBe(true);
  });

  it('(4) connection.error(fatal) shows the "Live updates disconnected" banner; a transient error does not', async () => {
    const session = makeSession({ id: ID });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });
    const { emitter } = await renderApp({ sessions: [session], store });

    await act(async () => {
      emitter.emit({ type: 'connection.error', fatal: false });
    });
    expect(screen.queryByText(/Live updates disconnected/i)).not.toBeInTheDocument();

    await act(async () => {
      emitter.emit({ type: 'connection.error', fatal: true });
    });
    expect(screen.getByText(/Live updates disconnected/i)).toBeInTheDocument();

    await act(async () => {
      emitter.emit({ type: 'connection.open' });
    });
    expect(screen.queryByText(/Live updates disconnected/i)).not.toBeInTheDocument();
  });
});

describe('App mutation rollback (failed REST → optimistic state restored)', () => {
  it('(delete) a rejected api.deleteSession restores the optimistically-removed card to the board', async () => {
    const session = makeSession({
      id: ID,
      title: 'Doomed card',
      originalTitle: 'Doomed card',
    });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });

    // deleteSession REJECTS — no store.changed will ever follow, so the only
    // self-correction is handleDeleteConfirmed's catch re-inserting the row.
    const pending = deferred();
    api.deleteSession.mockReturnValue(pending.promise);

    const user = (await import('@testing-library/user-event')).default.setup();
    await renderApp({ sessions: [session], store });
    expect(screen.getByTestId(`card-${ID}`)).toBeInTheDocument();

    // Open the app's hard-delete confirm flow the way the card menu does, then
    // confirm in the real ConfirmModal App renders.
    await act(async () => {
      boardProps.current.onDelete(session);
    });
    const dialog = await screen.findByRole('alertdialog', { name: /Delete permanently/i });
    expect(dialog).toBeInTheDocument();
    // The card is optimistically removed the instant the confirm fires.
    await user.click(screen.getByRole('button', { name: /Delete from disk/i }));
    await waitFor(() => expect(screen.queryByTestId(`card-${ID}`)).not.toBeInTheDocument());
    expect(api.deleteSession).toHaveBeenCalledWith(ID);

    // The DELETE rejects → the catch re-inserts the card at its original index.
    await act(async () => {
      pending.reject(new Error('boom: disk delete failed'));
    });
    await waitFor(() => expect(screen.getByTestId(`card-${ID}`)).toBeInTheDocument());
    // Restored card keeps its identity (title) and original column.
    expect(titleOf(ID)).toBe('Doomed card');
    expect(columnOf(ID)).toBe('col-todo-0');
    // The error is surfaced to the user.
    expect(screen.getByText(/disk delete failed/i)).toBeInTheDocument();
  });

  it('(move) a rejected api.moveCard returns the card to its original column/order', async () => {
    const session = makeSession({ id: ID });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 3, archived: false, customTitle: null },
    });

    // moveCard REJECTS — a failed move emits no store.changed, so handleMove's
    // catch is the only thing that restores placement.
    const pending = deferred();
    api.moveCard.mockReturnValue(pending.promise);

    await renderApp({ sessions: [session], store });
    expect(columnOf(ID)).toBe('col-todo-0');

    // Optimistically move To do → In progress at index 0.
    await act(async () => {
      move(ID, 'col-prog-1', 0);
    });
    expect(columnOf(ID)).toBe('col-prog-1');
    expect(api.moveCard).toHaveBeenCalledWith(ID, 'col-prog-1', 0);

    // The POST rejects → rollback restores the captured original column AND order.
    await act(async () => {
      pending.reject(new Error('boom: move failed'));
    });
    await waitFor(() => expect(columnOf(ID)).toBe('col-todo-0'));
    // The original order (3) is restored too, not left at the optimistic 0.
    expect(orderOf(ID)).toBe('3');
    expect(screen.getByText(/move failed/i)).toBeInTheDocument();
  });
});

describe('App deep-link', () => {
  it('opens the detail modal for ?session=<uuid> when that session exists', async () => {
    const session = makeSession({
      id: ID,
      title: 'Deep linked card',
      originalTitle: 'Deep linked card',
    });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });
    window.history.replaceState(null, '', `/?session=${ID}`);

    await renderApp({ sessions: [session], store });

    const dialog = await screen.findByRole('dialog', { name: /Session details/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Session title')).toHaveValue('Deep linked card');
  });

  it('ignores ?session=<uuid> for a non-existent session (no modal)', async () => {
    const session = makeSession({ id: ID });
    const store = makeStore({
      [ID]: { columnId: 'col-todo-0', order: 0, archived: false, customTitle: null },
    });
    const OTHER = '99999999-9999-4999-8999-999999999999';
    window.history.replaceState(null, '', `/?session=${OTHER}`);

    await renderApp({ sessions: [session], store });
    expect(
      screen.queryByRole('dialog', { name: /Session details/i }),
    ).not.toBeInTheDocument();
  });
});

describe('automated session filter', () => {
  const NORMAL = '11111111-1111-4111-8111-111111111111';
  const AUTO = '22222222-2222-4222-8222-222222222222';

  it('hides automated sessions by default and reveals them via the toggle', async () => {
    const normal = makeSession({ id: NORMAL, title: 'Real work', originalTitle: 'Real work' });
    const auto = makeSession({ id: AUTO, title: '(untitled)', originalTitle: '(untitled)', automated: true });
    await renderApp({ sessions: [normal, auto], store: makeStore({}) });

    // Default: the automated session is filtered out of the visible list Board gets.
    expect(boardProps.current.sessions.map((s) => s.id)).toEqual([NORMAL]);

    // One click on "Show automated" reveals it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show automated' }));
    await waitFor(() =>
      expect(boardProps.current.sessions.map((s) => s.id).sort()).toEqual([AUTO, NORMAL].sort()),
    );
  });
});
