// Card.jsx — a session card: title, project + branch, context-usage bar,
// last activity, message count + model, "reactivated" badge, lastPrompt on
// hover, and an actions menu (Archive, Delete).

import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { timeAgo, contextColor, isReactivated, resumeCommand } from '../util.js';
import CopyToast, { useCopyToast } from './CopyToast.jsx';

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
 * Presentational card markup. Does NOT call useSortable, so it is safe to render
 * inside a DragOverlay without re-registering the dragged id. The interactive
 * Card (below) wraps this with sortable wiring; the DragOverlay renders it
 * directly. Carries the single `.card` box itself — never nest two `.card`s.
 *
 * @param {Object} props
 * @param {object} props.session - SessionMeta merged with overlay fields.
 * @param {(session: object) => void} [props.onOpen] - open the details modal.
 * @param {(id: string, archived: boolean) => void} [props.onArchive]
 * @param {(session: object) => void} [props.onDelete]
 * @param {string} [props.className] - extra classes for the root `.card` element.
 * @param {object} [props.style] - inline style for the root element.
 * @param {React.Ref} [props.nodeRef] - ref for the root element (setNodeRef).
 * @param {object} [props.gripAttributes] - dnd-kit attributes for the grip.
 * @param {object} [props.gripListeners] - dnd-kit listeners for the grip.
 * @returns {JSX.Element}
 */
export function CardView({
  session,
  onOpen,
  onArchive,
  onDelete,
  className = '',
  style,
  nodeRef,
  gripAttributes,
  gripListeners,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const { copied, copy } = useCopyToast();

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const pct = session.contextPct;
  const reactivated = isReactivated(session);
  const branch = session.gitBranch;

  const rootClass = `card${session.archived ? ' card-archived' : ''}${
    className ? ` ${className}` : ''
  }`;

  // The card body opens the details modal on click. It is intentionally NOT a
  // role="button": it nests interactive controls (the ⋯ menu button and its
  // role="menu"), and an interactive element must not live inside a role=button.
  // So the body stays a plain clickable div (mouse affordance only) and keyboard
  // users get a dedicated, focusable "Open details" button rendered below — the
  // grip (drag) and the ⋯ menu still stop propagation so they never open the modal.
  const openable = typeof onOpen === 'function';
  const handleOpen = openable ? () => onOpen(session) : undefined;

  return (
    <div ref={nodeRef} style={style} className={rootClass}>
      {/* The card body is NOT a drag surface; only the .card-grip handle is. It
          is also NOT keyboard-focusable (no role/tabIndex) — see the dedicated
          "Open details" button below for the accessible open affordance. */}
      <div
        className={`card-body${openable ? ' card-body-clickable' : ''}`}
        onClick={handleOpen}
      >
        <div className="card-top">
          <span
            className="card-grip"
            aria-label="Drag"
            onClick={(e) => e.stopPropagation()}
            {...gripAttributes}
            {...gripListeners}
          >
            ⠿
          </span>
          <span className="card-title" title={session.title}>
            {session.title || '(untitled)'}
          </span>
          {openable ? (
            // Accessible open affordance for keyboard/SR users: the body click is
            // mouse-only (a plain div), so this real, focusable button is the
            // keyboard path to the details modal. Same action as a body click;
            // stopPropagation avoids a redundant second open from the body.
            <button
              type="button"
              className="icon-btn card-open-btn"
              aria-label={`Open details for ${session.title || '(untitled)'}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(session);
              }}
            >
              ⤢
            </button>
          ) : null}
          <div className="card-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              ref={menuButtonRef}
              className="icon-btn"
              aria-label="Actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              ⋯
            </button>
            {menuOpen ? (
              <div className="menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    menuButtonRef.current?.focus();
                    // Pure client affordance: copy the resume command so the user
                    // can paste it into a terminal. No backend, read-only.
                    copy(resumeCommand(session));
                  }}
                >
                  Copy resume command
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    // Restore focus to the menu button before the menu unmounts,
                    // matching the Escape path, so keyboard focus doesn't fall to
                    // <body>. (Archive keeps the card in place; for Delete the
                    // confirm modal takes focus, so this is harmless there.)
                    menuButtonRef.current?.focus();
                    onArchive?.(session.id, !session.archived);
                  }}
                >
                  {session.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item menu-item-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    menuButtonRef.current?.focus();
                    onDelete?.(session);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
            <CopyToast show={copied} className="copy-toast-card" />
          </div>
        </div>

        <div className="card-sub">
          <span className="card-project" title={session.projectPath || session.projectName}>
            {session.projectName || session.projectDir}
          </span>
          {branch ? <span className="card-branch">⎇ {branch}</span> : null}
          {reactivated ? <span className="badge badge-reactivated">reactivated</span> : null}
          {session.archived ? <span className="badge badge-archived">archived</span> : null}
        </div>

        {/* Context-usage bar */}
        <div className="ctx-row" title={pct == null ? 'Context unknown' : `Context ${pct}%`}>
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

/**
 * @param {Object} props
 * @param {object} props.session - SessionMeta merged with overlay fields.
 * @param {(session: object) => void} [props.onOpen]
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @returns {JSX.Element}
 */
export default function Card({ session, onOpen, onArchive, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
    data: { type: 'card', columnId: session.columnId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <CardView
      session={session}
      onOpen={onOpen}
      onArchive={onArchive}
      onDelete={onDelete}
      nodeRef={setNodeRef}
      style={style}
      gripAttributes={attributes}
      gripListeners={listeners}
    />
  );
}
