// ConfirmModal.jsx — generic confirmation modal, used notably for the
// irreversible "Delete permanently" action.

import { useEffect, useRef } from 'react';

import { trapTab } from '../focusTrap.js';

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {string} props.title
 * @param {React.ReactNode} [props.children] - Body / explanation.
 * @param {string} [props.confirmLabel="Confirm"]
 * @param {string} [props.cancelLabel="Cancel"]
 * @param {boolean} [props.danger=false] - Style the confirm button as destructive.
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @returns {JSX.Element|null}
 */
export default function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCancel?.();
        return;
      }
      // Do NOT fire a global Enter-to-confirm: a stray Enter while focus is
      // elsewhere (e.g. a search box) must never trigger an irreversible delete.
      // The confirm button is focused on open, so Enter on it activates the
      // button natively. Here we only handle Enter when the confirm button is
      // the active element (covers cases where the click handler isn't reached).
      if (e.key === 'Enter' && document.activeElement === confirmRef.current) {
        e.preventDefault();
        onConfirm?.();
        return;
      }
      // Focus trap: keep Tab cycling within the dialog.
      trapTab(e, dialogRef.current);
    };
    window.addEventListener('keydown', onKey);
    // Focus the primary action when the modal opens.
    confirmRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        {children ? <div className="modal-body">{children}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
