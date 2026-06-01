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

/**
 * Group sessions by their columnId, each group sorted by `order` then lastActivity.
 * @param {object[]} sessions
 * @param {object[]} columns
 * @returns {Map<string, object[]>}
 */
function groupByColumn(sessions, columns) {
  const map = new Map();
  for (const col of columns) map.set(col.id, []);
  const fallback = columns[0]?.id;
  for (const s of sessions) {
    const colId = map.has(s.columnId) ? s.columnId : fallback;
    if (colId == null) continue;
    if (!map.has(colId)) map.set(colId, []);
    map.get(colId).push(s);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ao = a.order ?? 0;
      const bo = b.order ?? 0;
      if (ao !== bo) return ao - bo;
      // tiebreak: most recent first
      return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
    });
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
}) {
  const [activeId, setActiveId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(() => groupByColumn(sessions, columns), [sessions, columns]);
  // Full (unfiltered) column membership, sorted the same way the visible board is.
  // Used to map a filtered drop position to a full-column index for onMove.
  const groupedAll = useMemo(
    () => groupByColumn(allSessions || sessions, columns),
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

    let newIndex;
    if (grouped.has(over.id)) {
      // dropped onto the column container (empty area) → append after all cards
      newIndex = fullList.length;
    } else {
      const overIndex = fullList.findIndex((s) => s.id === over.id);
      newIndex = overIndex < 0 ? fullList.length : overIndex;
    }

    if (activeColId === overColId) {
      const oldIndex = fullList.findIndex((s) => s.id === active.id);
      if (oldIndex < 0) return;
      if (oldIndex === newIndex) return;
      // The order value is the destination index after reordering.
      const reordered = arrayMove(fullList, oldIndex, newIndex);
      const finalIndex = reordered.findIndex((s) => s.id === active.id);
      onMove?.(active.id, overColId, finalIndex, reordered);
    } else {
      // Cross-column move: build the destination's new full ordering so the
      // optimistic state matches what the server will renumber to.
      const reordered = fullList.slice();
      const insertAt = Math.min(newIndex, reordered.length);
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
