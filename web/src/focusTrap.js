// focusTrap.js — shared keyboard focus-trap helper for modal dialogs. Extracted
// so the FOCUSABLE selector and the Tab/Shift+Tab cycling logic live in ONE
// place (previously duplicated across ConfirmModal, CardDetailModal, and missing
// entirely from ColumnEditor). Any future tweak to the focusable heuristic
// applies everywhere at once.

/** Selector for tabbable elements used by the focus trap. */
export const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Handle a keydown event to keep Tab focus cycling within `dialogEl`. Call this
 * from a dialog's keydown listener; it only acts on Tab and is a no-op otherwise.
 *
 * @param {KeyboardEvent} e
 * @param {HTMLElement|null} dialogEl - The dialog root to trap focus within.
 */
export function trapTab(e, dialogEl) {
  if (e.key !== 'Tab' || !dialogEl) return;
  const focusable = Array.from(dialogEl.querySelectorAll(FOCUSABLE)).filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
