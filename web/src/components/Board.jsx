// Board.jsx — renders the columns and wires up dnd-kit drag-and-drop for moving
// cards within and across columns. On drop it computes the target column + order
// and calls the move callback (which hits the API and updates state).

import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import Column from './Column.jsx';
import Card from './Card.jsx';

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
 * @param {object[]} props.columns - ordered columns.
 * @param {(id: string, columnId: string, order: number) => void} props.onMove
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @returns {JSX.Element}
 */
export default function Board({ sessions, columns, onMove, onArchive, onDelete }) {
  const [activeId, setActiveId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const grouped = useMemo(() => groupByColumn(sessions, columns), [sessions, columns]);
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

    const targetList = grouped.get(overColId) || [];

    let newIndex;
    if (grouped.has(over.id)) {
      // dropped onto the column container (empty area) → append
      newIndex = targetList.length;
    } else {
      const overIndex = targetList.findIndex((s) => s.id === over.id);
      newIndex = overIndex < 0 ? targetList.length : overIndex;
    }

    if (activeColId === overColId) {
      const oldIndex = targetList.findIndex((s) => s.id === active.id);
      if (oldIndex === newIndex || oldIndex < 0) return;
      // The order value is the destination index after reordering.
      const reordered = arrayMove(targetList, oldIndex, newIndex);
      const finalIndex = reordered.findIndex((s) => s.id === active.id);
      onMove?.(active.id, overColId, finalIndex);
    } else {
      onMove?.(active.id, overColId, newIndex);
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
            onArchive={onArchive}
            onDelete={onDelete}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeSession ? (
          <div className="card card-dragging">
            <Card session={activeSession} onArchive={() => {}} onDelete={() => {}} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
