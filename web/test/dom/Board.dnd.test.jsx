// Board.dnd.test.jsx — exercises Board.handleDragEnd, the cross/same-column drop
// math the review flagged as untested. A real dnd-kit pointer drag needs layout
// jsdom doesn't provide, so instead we mock @dnd-kit/core's DndContext with a
// passthrough that CAPTURES the real onDragEnd handler Board passes it, then call
// that handler with synthetic { active, over } events. This runs the genuine
// Board.jsx decision logic (filtered→full index mapping + sort-aware decision),
// so a regression in source is caught. Column is mocked to a plain renderer so
// the board mounts without the dnd hooks.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

// Capture the onDragEnd Board hands to DndContext; render children passthrough.
const dnd = { onDragEnd: null, onDragStart: null };
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DndContext: (props) => {
      dnd.onDragEnd = props.onDragEnd;
      dnd.onDragStart = props.onDragStart;
      return props.children;
    },
    DragOverlay: ({ children }) => children ?? null,
  };
});

// Plain Column so no useDroppable/useSortable is needed (we call handleDragEnd
// directly; the DOM the columns render is irrelevant to the index math).
vi.mock('../../src/components/Column.jsx', () => ({
  default: ({ column }) => <div data-testid={`col-${column.id}`}>{column.name}</div>,
}));

import Board from '../../src/components/Board.jsx';

const COLUMNS = [
  { id: 'A', name: 'A', order: 0 },
  { id: 'B', name: 'B', order: 1 },
];

/** A session with the fields Board's math reads. */
function s(id, columnId, order, extra = {}) {
  return { id, columnId, order, lastActivity: '2026-06-01T00:00:00.000Z', ...extra };
}

function renderBoard({ sessions, allSessions, sortKey = 'board' }) {
  const onMove = vi.fn();
  render(
    <Board
      sessions={sessions}
      allSessions={allSessions || sessions}
      columns={COLUMNS}
      sortKey={sortKey}
      onMove={onMove}
      onArchive={() => {}}
      onDelete={() => {}}
    />,
  );
  return onMove;
}

beforeEach(() => {
  dnd.onDragEnd = null;
});

describe('Board.handleDragEnd — filtered→full index mapping', () => {
  it('translates a cross-column drop index against the FULL (unfiltered) column, not the visible subset', () => {
    // Full column B has [b0, b1, b2]; the VISIBLE board hides b1 (filtered out),
    // so B visibly shows [b0, b2]. Dropping A's card "x" onto the visible "b2"
    // must insert at b2's index in the FULL list (2), not its visible index (1).
    const full = {
      A: [s('x', 'A', 0)],
      B: [s('b0', 'B', 0), s('b1', 'B', 1), s('b2', 'B', 2)],
    };
    const allSessions = [...full.A, ...full.B];
    const visible = [s('x', 'A', 0), s('b0', 'B', 0), s('b2', 'B', 2)]; // b1 hidden

    const onMove = renderBoard({ sessions: visible, allSessions });
    dnd.onDragEnd({ active: { id: 'x' }, over: { id: 'b2' } });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, colId, order, reordered] = onMove.mock.calls[0];
    expect(id).toBe('x');
    expect(colId).toBe('B');
    // b2 sits at FULL index 2 → insert there.
    expect(order).toBe(2);
    // The reordered full ordering places x at index 2.
    expect(reordered.map((r) => r.id)).toEqual(['b0', 'b1', 'x', 'b2']);
  });

  it('dropping on the destination COLUMN (not a card) appends at the end of the FULL column', () => {
    const allSessions = [s('x', 'A', 0), s('b0', 'B', 0), s('b1', 'B', 1)];
    const onMove = renderBoard({ sessions: allSessions, allSessions });
    // over.id is the column id 'B' itself.
    dnd.onDragEnd({ active: { id: 'x' }, over: { id: 'B' } });

    const [id, colId, order, reordered] = onMove.mock.calls[0];
    expect(id).toBe('x');
    expect(colId).toBe('B');
    expect(order).toBe(2); // appended after b0,b1
    expect(reordered.map((r) => r.id)).toEqual(['b0', 'b1', 'x']);
  });

  it('same-column reorder uses arrayMove on the full list and sends the destination index', () => {
    const allSessions = [s('a0', 'A', 0), s('a1', 'A', 1), s('a2', 'A', 2)];
    const onMove = renderBoard({ sessions: allSessions, allSessions });
    // Drag a0 onto a2 → a0 moves to a2's slot.
    dnd.onDragEnd({ active: { id: 'a0' }, over: { id: 'a2' } });

    const [id, colId, order, reordered] = onMove.mock.calls[0];
    expect(id).toBe('a0');
    expect(colId).toBe('A');
    expect(order).toBe(2);
    expect(reordered.map((r) => r.id)).toEqual(['a1', 'a2', 'a0']);
  });

  it('a no-op same-column drop (onto itself) does not call onMove', () => {
    const allSessions = [s('a0', 'A', 0), s('a1', 'A', 1)];
    const onMove = renderBoard({ sessions: allSessions, allSessions });
    dnd.onDragEnd({ active: { id: 'a0' }, over: { id: 'a0' } });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('a drop with no `over` target is ignored', () => {
    const allSessions = [s('a0', 'A', 0)];
    const onMove = renderBoard({ sessions: allSessions, allSessions });
    dnd.onDragEnd({ active: { id: 'a0' }, over: null });
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('Board.handleDragEnd — sort-aware drag decision', () => {
  it('under a non-board sort, a SAME-column reorder is a no-op (visible order is not board order)', () => {
    const allSessions = [s('a0', 'A', 0), s('a1', 'A', 1)];
    const onMove = renderBoard({ sessions: allSessions, allSessions, sortKey: 'activity' });
    dnd.onDragEnd({ active: { id: 'a0' }, over: { id: 'a1' } });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('under a non-board sort, a CROSS-column move still works but APPENDS (ignores the over-card index)', () => {
    // Full B = [b0, b1]; dropping x onto b0 under 'activity' sort must NOT honor
    // b0's index — it appends at the end (index 2) instead.
    const allSessions = [s('x', 'A', 0), s('b0', 'B', 0), s('b1', 'B', 1)];
    const onMove = renderBoard({ sessions: allSessions, allSessions, sortKey: 'context' });
    dnd.onDragEnd({ active: { id: 'x' }, over: { id: 'b0' } });

    const [id, colId, order, reordered] = onMove.mock.calls[0];
    expect(id).toBe('x');
    expect(colId).toBe('B');
    expect(order).toBe(2); // appended, NOT inserted at b0's index 0
    expect(reordered.map((r) => r.id)).toEqual(['b0', 'b1', 'x']);
  });
});
