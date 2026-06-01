// Column.jsx — a single Kanban column: header (name/color, count) and a
// droppable, sortable list of cards.

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import Card from './Card.jsx';

/**
 * @param {Object} props
 * @param {object} props.column - { id, name, color, order }
 * @param {object[]} props.sessions - sessions assigned to this column (sorted by order).
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @returns {JSX.Element}
 */
export default function Column({ column, sessions, onArchive, onDelete }) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: 'column', columnId: column.id },
  });

  const ids = sessions.map((s) => s.id);

  return (
    <section className={`column${isOver ? ' column-over' : ''}`}>
      <header className="column-header">
        <span className="column-dot" style={{ background: column.color || 'var(--accent)' }} />
        <h2 className="column-name">{column.name}</h2>
        <span className="column-count">{sessions.length}</span>
      </header>

      <div ref={setNodeRef} className="column-body">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {sessions.map((s) => (
            <Card key={s.id} session={s} onArchive={onArchive} onDelete={onDelete} />
          ))}
        </SortableContext>
        {sessions.length === 0 ? <div className="column-empty">No sessions</div> : null}
      </div>
    </section>
  );
}
