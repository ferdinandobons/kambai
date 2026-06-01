// Board.jsx — renders the columns and wires up dnd-kit drag-and-drop for moving
// cards within and across columns. On drop it computes the target column + order
// and calls the move callback (which hits the API and updates state).

import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import Column from './Column.jsx';
import Card, { CardView } from './Card.jsx';
import { sessionComparator } from '../util.js';

/**
 * Group sessions by their columnId, each group sorted with the comparator for
 * `sortKey` ('board' = the existing order-then-lastActivity behavior).
 * @param {object[]} sessions
 * @param {object[]} columns
 * @param {string} [sortKey]
 * @returns {Map<string, object[]>}
 */
function groupByColumn(sessions, columns, sortKey = 'board') {
  const map = new Map();
  for (const col of columns) map.set(col.id, []);
  const fallback = columns[0]?.id;
  for (const s of sessions) {
    const colId = map.has(s.columnId) ? s.columnId : fallback;
    if (colId == null) continue;
    if (!map.has(colId)) map.set(colId, []);
    map.get(colId).push(s);
  }
  const compare = sessionComparator(sortKey);
  for (const list of map.values()) {
    list.sort(compare);
  }
  return map;
}

/**
 * @param {Object} props
 * @param {object[]} props.sessions - visible sessions (filtered), merged with overlay.
 * @param {object[]} [props.allSessions] - the FULL (unfiltered) session list, used
 *   to translate a filtered drop index into a position in the full column so the
 *   server's renumber (which spans every card in the column) stays in sync.
 * @param {object[]} props.columns - ordered columns.
 * @param {(id: string, columnId: string, order: number) => void} props.onMove
 * @param {(session: object) => void} [props.onOpen] - open the details modal.
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @param {string} [props.sortKey] - how to order cards within each column.
 * @returns {JSX.Element}
 */
export default function Board({
  sessions,
  allSessions,
  columns,
  onMove,
  onOpen,
  onArchive,
  onDelete,
  sortKey = 'board',
}) {
  const [activeId, setActiveId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(
    () => groupByColumn(sessions, columns, sortKey),
    [sessions, columns, sortKey],
  );
  // Full (unfiltered) column membership. Drop-index math (and the server's
  // renumber) is always anchored on the canonical BOARD order, independent of
  // the current view sort — so cross-column drag-and-drop keeps working exactly
  // as today even when the visible cards are sorted by another key.
  const groupedAll = useMemo(
    () => groupByColumn(allSessions || sessions, columns, 'board'),
    [allSessions, sessions, columns],
  );
  const byId = useMemo(() => {
    const m = new Map();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const activeSession = activeId ? byId.get(activeId) : null;

  /** Resolve which column a draggable/droppable id belongs to. */
  const columnIdOf = (id) => {
    if (grouped.has(id)) return id; // dropped on the column itself
    const s = byId.get(id);
    return s ? (grouped.has(s.columnId) ? s.columnId : columns[0]?.id) : null;
  };

  const handleDragStart = (event) => setActiveId(event.active.id);
  const handleDragCancel = () => setActiveId(null);

  // Manual drop position only carries meaning under 'board' sort: the non-board
  // comparators ignore `order`, so a freshly-renumbered card would just re-sort
  // by its active key and snap away from where it was dropped. Under any other
  // sort we therefore only honor CROSS-column moves (column membership is real)
  // and append the card at the end of the destination — never reorder within a
  // column (which would be a silent no-op / jump). See the hint in render().
  const orderingMeaningful = sortKey === 'board';

  const handleDragEnd = (event) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeColId = columnIdOf(active.id);
    const overColId = columnIdOf(over.id);
    if (activeColId == null || overColId == null) return;

    // The server renumbers EVERY card in the destination column (archived and
    // filtered-out cards included), so the order we send must be an index into
    // the FULL column, not the visible/filtered subset. Anchor off the `over`
    // card's real position in the full column.
    const fullList = groupedAll.get(overColId) || [];

    if (activeColId === overColId) {
      // Same-column drop. Only honor the drop position under 'board' sort; under
      // a non-board sort the visible order is not the board order, so reordering
      // here is meaningless — leave the card where it is.
      if (!orderingMeaningful) return;
      const oldIndex = fullList.findIndex((s) => s.id === active.id);
      if (oldIndex < 0) return;
      let newIndex;
      if (grouped.has(over.id)) {
        newIndex = fullList.length;
      } else {
        const overIndex = fullList.findIndex((s) => s.id === over.id);
        newIndex = overIndex < 0 ? fullList.length : overIndex;
      }
      if (oldIndex === newIndex) return;
      // The order value is the destination index after reordering.
      const reordered = arrayMove(fullList, oldIndex, newIndex);
      const finalIndex = reordered.findIndex((s) => s.id === active.id);
      onMove?.(active.id, overColId, finalIndex, reordered);
    } else {
      // Cross-column move. Under 'board' sort, honor the visual drop position;
      // under a non-board sort the visible order isn't the board order, so the
      // `over` card's board index is meaningless — append at the end instead.
      let insertAt;
      if (orderingMeaningful && !grouped.has(over.id)) {
        const overIndex = fullList.findIndex((s) => s.id === over.id);
        insertAt = overIndex < 0 ? fullList.length : overIndex;
      } else {
        insertAt = fullList.length;
      }
      // Build the destination's new full ordering so the optimistic state
      // matches what the server will renumber to.
      const reordered = fullList.slice();
      insertAt = Math.min(insertAt, reordered.length);
      reordered.splice(insertAt, 0, byId.get(active.id) || { id: active.id });
      onMove?.(active.id, overColId, insertAt, reordered);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {!orderingMeaningful ? (
        <div className="board-sort-hint" role="status">
          Cards are sorted by the active view — drag still moves cards between
          columns, but manual ordering within a column only applies in “Board
          order”.
        </div>
      ) : null}
      <div className="board">
        {columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            sessions={grouped.get(col.id) || []}
            onOpen={onOpen}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeSession ? (
          // Presentational clone only: CardView does NOT call useSortable, so it
          // never re-registers the dragged id (which is still mounted in its
          // column). It also carries the single `.card` box itself, so we add
          // only the drag modifier here — no double-wrapping.
          <CardView session={activeSession} className="card-dragging" />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
