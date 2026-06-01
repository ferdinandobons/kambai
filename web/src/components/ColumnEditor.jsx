// ColumnEditor.jsx — modal to add / rename / reorder / delete columns.
// Deleting a column that still holds cards prompts for a target column
// (moveCardsTo) before the destructive call.

import { useEffect, useRef, useState } from 'react';

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {object[]} props.columns - ordered columns [{ id, name, color, order }]
 * @param {Record<string, number>} props.counts - sessionId-free map of columnId → card count.
 * @param {(name: string) => Promise<void>|void} props.onAdd
 * @param {(id: string, name: string) => Promise<void>|void} props.onRename
 * @param {(ids: string[]) => Promise<void>|void} props.onReorder
 * @param {(id: string, moveCardsTo: string) => Promise<void>|void} props.onDelete
 * @param {() => void} props.onClose
 * @returns {JSX.Element|null}
 */
export default function ColumnEditor({
  open,
  columns,
  counts = {},
  onAdd,
  onRename,
  onReorder,
  onDelete,
  onClose,
}) {
  const [newName, setNewName] = useState('');
  // Column currently pending deletion (needs a moveCardsTo choice).
  const [pendingDelete, setPendingDelete] = useState(null);
  const [moveTarget, setMoveTarget] = useState('');
  const dialogRef = useRef(null);
  // Keep the latest onClose without re-running the open effect (the parent
  // passes an inline arrow, so its identity changes every render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    // Move initial focus into the dialog so keyboard users land inside it.
    // Runs only on the open transition, so it never steals focus mid-typing.
    const firstInput = dialogRef.current?.querySelector('input, select, button');
    firstInput?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const order = columns.map((c) => c.id);

  const move = (id, dir) => {
    const idx = order.indexOf(id);
    const swap = idx + dir;
    if (swap < 0 || swap >= order.length) return;
    const next = order.slice();
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onReorder?.(next);
  };

  const requestDelete = (col) => {
    const count = counts[col.id] || 0;
    if (columns.length <= 1) return; // never delete the last column
    if (count > 0) {
      // ask where to move the cards
      const firstOther = columns.find((c) => c.id !== col.id);
      setMoveTarget(firstOther ? firstOther.id : '');
      setPendingDelete(col);
    } else {
      // No cards to move, but the route + store still require a valid sibling
      // target (the move is a harmless no-op). Mirror the non-empty branch.
      const firstOther = columns.find((c) => c.id !== col.id);
      onDelete?.(col.id, firstOther ? firstOther.id : '');
    }
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    onDelete?.(pendingDelete.id, moveTarget);
    setPendingDelete(null);
    setMoveTarget('');
  };

  const submitAdd = (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    onAdd?.(name);
    setNewName('');
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Gestione colonne"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Colonne</h2>

        <ul className="col-editor-list">
          {columns.map((col, i) => (
            <li key={col.id} className="col-editor-row">
              <span
                className="column-dot"
                style={{ background: col.color || 'var(--accent)' }}
              />
              <input
                className="filter-input col-editor-name"
                value={col.name}
                onChange={(e) => onRename?.(col.id, e.target.value)}
                aria-label={`Nome colonna ${col.name}`}
              />
              <span className="col-editor-count">{counts[col.id] || 0}</span>
              <div className="col-editor-arrows">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Sposta su"
                  disabled={i === 0}
                  onClick={() => move(col.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Sposta giù"
                  disabled={i === columns.length - 1}
                  onClick={() => move(col.id, +1)}
                >
                  ↓
                </button>
              </div>
              <button
                type="button"
                className="icon-btn icon-btn-danger"
                aria-label={`Elimina colonna ${col.name}`}
                disabled={columns.length <= 1}
                title={columns.length <= 1 ? 'Deve restare almeno una colonna' : 'Elimina colonna'}
                onClick={() => requestDelete(col)}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>

        <form className="col-editor-add" onSubmit={submitAdd}>
          <input
            className="filter-input"
            placeholder="Nuova colonna…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            Aggiungi
          </button>
        </form>

        {pendingDelete ? (
          <div className="col-editor-delete-prompt">
            <p>
              La colonna <strong>{pendingDelete.name}</strong> contiene{' '}
              {counts[pendingDelete.id] || 0} card. Dove vuoi spostarle?
            </p>
            <div className="col-editor-delete-actions">
              <select
                className="filter-input"
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
              >
                {columns
                  .filter((c) => c.id !== pendingDelete.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
                Annulla
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>
                Sposta ed elimina
              </button>
            </div>
          </div>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
