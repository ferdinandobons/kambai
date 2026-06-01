// Card.jsx — a session card: title, project + branch, context-usage bar,
// last activity, message count + model, "riattivata" badge, lastPrompt on
// hover, and an actions menu (Archivia, Elimina).

import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { timeAgo, contextColor } from '../util.js';

/**
 * Shorten a model id for display, e.g. "claude-opus-4-7" → "opus-4-7".
 * @param {string|null} model
 * @returns {string}
 */
function shortModel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '');
}

/**
 * Has this card been "reactivated"? True when new activity arrived after the
 * card was last moved into a done column (lastActivity > lastDoneActivity).
 * @param {object} session
 * @returns {boolean}
 */
function isReactivated(session) {
  const done = session.lastDoneActivity;
  if (!done || !session.lastActivity) return false;
  return new Date(session.lastActivity).getTime() > new Date(done).getTime();
}

/**
 * @param {Object} props
 * @param {object} props.session - SessionMeta merged with overlay fields.
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @returns {JSX.Element}
 */
export default function Card({ session, onArchive, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
    data: { type: 'card', columnId: session.columnId },
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  const pct = session.contextPct;
  const reactivated = isReactivated(session);
  const branch = session.gitBranch;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${session.archived ? ' card-archived' : ''}`}
      {...attributes}
    >
      {/* Drag handle covers the card body; the menu button stops propagation. */}
      <div className="card-grab" {...listeners}>
        <div className="card-top">
          <span className="card-title" title={session.title}>
            {session.title || '(senza titolo)'}
          </span>
          <div className="card-menu" ref={menuRef}>
            <button
              type="button"
              className="icon-btn"
              aria-label="Azioni"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              ⋯
            </button>
            {menuOpen ? (
              <div className="menu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onArchive?.(session.id, !session.archived);
                  }}
                >
                  {session.archived ? 'Ripristina' : 'Archivia'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item menu-item-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onDelete?.(session);
                  }}
                >
                  Elimina
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="card-sub">
          <span className="card-project" title={session.projectPath || session.projectName}>
            {session.projectName || session.projectDir}
          </span>
          {branch ? <span className="card-branch">⎇ {branch}</span> : null}
          {reactivated ? <span className="badge badge-reactivated">riattivata</span> : null}
          {session.archived ? <span className="badge badge-archived">archiviata</span> : null}
        </div>

        {/* Context-usage bar */}
        <div className="ctx-row" title={pct == null ? 'Contesto sconosciuto' : `Contesto ${pct}%`}>
          <div className="ctx-bar">
            <div
              className="ctx-fill"
              style={{
                width: pct == null ? '100%' : `${Math.min(100, Math.max(2, pct))}%`,
                background: contextColor(pct),
                opacity: pct == null ? 0.25 : 1,
              }}
            />
          </div>
          <span className="ctx-pct" style={{ color: contextColor(pct) }}>
            {pct == null ? '—' : `${pct}%`}
          </span>
        </div>

        <div className="card-meta">
          <span className="meta-time">{timeAgo(session.lastActivity)}</span>
          <span className="meta-dot">·</span>
          <span className="meta-msgs">{session.messageCount ?? 0} msg</span>
          {session.model ? (
            <>
              <span className="meta-dot">·</span>
              <span className="meta-model">{shortModel(session.model)}</span>
            </>
          ) : null}
        </div>

        {session.lastPrompt ? (
          <div className="card-prompt" title={session.lastPrompt}>
            {session.lastPrompt}
          </div>
        ) : null}
      </div>
    </div>
  );
}
