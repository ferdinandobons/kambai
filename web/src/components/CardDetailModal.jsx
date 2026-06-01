// CardDetailModal.jsx — full details view for a single session card. Shows an
// editable title (stored as a custom override in our overlay, never touching the
// read-only session file), a details grid of the parsed metadata, the full
// lastPrompt, and footer actions (archive/restore, delete, close).

import { useEffect, useRef, useState } from 'react';
import { timeAgo, resumeCommand } from '../util.js';
import { trapTab } from '../focusTrap.js';
import CopyToast, { useCopyToast } from './CopyToast.jsx';

/** Display a value, falling back to an em dash for empty/missing values. */
function display(value) {
  if (value == null || value === '') return '—';
  return value;
}

/** Format an ISO timestamp as an absolute, locale-friendly string. */
function formatDate(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleString();
}

/**
 * @param {Object} props
 * @param {object} props.session - SessionMeta merged with overlay fields
 *   (title is the effective title; originalTitle/customTitle carry the override).
 * @param {() => void} props.onClose
 * @param {(id: string, title: string) => void} props.onRename - empty string resets.
 * @param {(id: string, archived: boolean) => void} props.onArchive
 * @param {(session: object) => void} props.onDelete
 * @returns {JSX.Element|null}
 */
export default function CardDetailModal({ session, onClose, onRename, onArchive, onDelete }) {
  const dialogRef = useRef(null);
  const titleInputRef = useRef(null);
  const [draft, setDraft] = useState('');
  const { copied, copy } = useCopyToast();

  const sessionId = session?.id;
  const effectiveTitle = session?.title ?? '';

  // Reset the editable draft ONLY when a different card opens (card identity
  // changes). We intentionally do NOT re-key on effectiveTitle: a live rename of
  // the SAME card arriving via SSE while the user is mid-edit would otherwise
  // silently overwrite their unsaved draft. On a fresh card the draft seeds from
  // the current effective title.
  useEffect(() => {
    setDraft(session?.title ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // One-time focus+select of the title input, keyed only on card identity. This
  // is deliberately separate from the keydown listener below so live
  // session.updated events (which produce a new `session` object reference every
  // few seconds for an active card) do NOT steal focus and re-select the input
  // while the user is editing the title.
  useEffect(() => {
    if (sessionId == null) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [sessionId]);

  useEffect(() => {
    if (!session) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      // Focus trap: keep Tab cycling within the dialog.
      trapTab(e, dialogRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Keyed on whether a modal is open (not the whole session object) plus
    // onClose, so the listener is not torn down/re-added on every content update.
  }, [!!session, onClose]);

  if (!session) return null;

  const original = session.originalTitle ?? session.title ?? '';
  const hasCustom = !!(session.customTitle && session.customTitle.trim());
  const trimmedDraft = draft.trim();
  // Save is meaningful when the draft differs from the current effective title.
  const unchanged = trimmedDraft === (effectiveTitle || '').trim();

  const save = () => {
    if (unchanged) return;
    onRename?.(session.id, draft);
  };

  const resetToOriginal = () => {
    onRename?.(session.id, '');
  };

  const pct = session.contextPct;
  const ctxValue =
    pct == null && session.contextTokens == null
      ? '—'
      : `${pct == null ? '—' : `${pct}%`}${
          session.contextTokens != null
            ? ` (${session.contextTokens.toLocaleString()} tokens)`
            : ''
        }`;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal modal-wide modal-detail"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Editable title */}
        <div className="detail-title-row">
          <input
            ref={titleInputRef}
            className="filter-input detail-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
            aria-label="Session title"
            placeholder="Untitled session"
          />
          <button
            type="button"
            className="btn btn-resume"
            onClick={() => copy(resumeCommand(session))}
            title={resumeCommand(session)}
          >
            Resume
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={unchanged}>
            Save
          </button>
        </div>

        <CopyToast show={copied} className="copy-toast-detail" />

        {hasCustom ? (
          <div className="detail-title-hint">
            <span className="muted">
              Original: <span className="detail-original">{display(original)}</span>
            </span>
            <button type="button" className="btn btn-link" onClick={resetToOriginal}>
              Reset to original
            </button>
          </div>
        ) : null}

        {/* Details grid */}
        <dl className="detail-grid">
          <dt>Project</dt>
          <dd>{display(session.projectName || session.projectDir)}</dd>

          <dt>Path</dt>
          <dd className="detail-path">{display(session.projectPath)}</dd>

          <dt>Branch</dt>
          <dd>{display(session.gitBranch)}</dd>

          <dt>Model</dt>
          <dd>{display(session.model)}</dd>

          <dt>Context</dt>
          <dd>{ctxValue}</dd>

          <dt>Messages</dt>
          <dd>{session.messageCount ?? 0}</dd>

          <dt>Last activity</dt>
          <dd>
            {timeAgo(session.lastActivity)}
            {session.lastActivity ? (
              <span className="muted detail-abs"> · {formatDate(session.lastActivity)}</span>
            ) : null}
          </dd>

          <dt>Created</dt>
          <dd>{formatDate(session.createdAt)}</dd>

          <dt>Session ID</dt>
          <dd className="detail-id">{display(session.id)}</dd>
        </dl>

        {session.lastPrompt ? (
          <div className="detail-prompt-block">
            <div className="detail-prompt-label">Last prompt</div>
            <div className="detail-prompt">{session.lastPrompt}</div>
          </div>
        ) : null}

        {/* Footer actions */}
        <div className="modal-actions detail-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onDelete?.(session)}
          >
            Delete
          </button>
          <div className="detail-actions-right">
            <button
              type="button"
              className="btn"
              onClick={() => onArchive?.(session.id, !session.archived)}
            >
              {session.archived ? 'Restore' : 'Archive'}
            </button>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
