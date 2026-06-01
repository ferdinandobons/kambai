// ConfirmModal.jsx — generic confirmation modal, used notably for the
// irreversible "Elimina definitivamente" action.

import { useEffect, useRef } from 'react';

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {string} props.title
 * @param {React.ReactNode} [props.children] - Body / explanation.
 * @param {string} [props.confirmLabel="Conferma"]
 * @param {string} [props.cancelLabel="Annulla"]
 * @param {boolean} [props.danger=false] - Style the confirm button as destructive.
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @returns {JSX.Element|null}
 */
export default function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Conferma',
  cancelLabel = 'Annulla',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
      if (e.key === 'Enter') onConfirm?.();
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
