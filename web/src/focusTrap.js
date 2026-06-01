// focusTrap.js — shared keyboard focus-trap helper for modal dialogs. Extracted
// so the FOCUSABLE selector and the Tab/Shift+Tab cycling logic live in ONE
// place (previously duplicated across ConfirmModal, CardDetailModal, and missing
// entirely from ColumnEditor). Any future tweak to the focusable heuristic
// applies everywhere at once. Also hosts useInertBackground, the shared hook
// that marks the board behind an open modal inert + aria-hidden.

import { useEffect } from 'react';

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

/**
 * While `active`, mark the element returned by `getEl()` inert and aria-hidden so
 * assistive tech and Tab cannot reach background content behind an open modal;
 * restore the prior values on deactivate/unmount. Set imperatively (not as a JSX
 * prop) because React 18 does not pass the `inert` attribute through reliably.
 * The modal keeps its own focus trap; this just seals off everything else.
 *
 * @param {boolean} active - Whether a modal is currently open.
 * @param {() => HTMLElement|null} getEl - Returns the background element to seal.
 */
export function useInertBackground(active, getEl) {
  useEffect(() => {
    if (!active) return undefined;
    const el = getEl();
    if (!el) return undefined;
    const hadInert = el.hasAttribute('inert');
    const prevAriaHidden = el.getAttribute('aria-hidden');
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    return () => {
      if (!hadInert) el.removeAttribute('inert');
      if (prevAriaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', prevAriaHidden);
    };
    // getEl is a stable accessor (DOM lookup); re-run only when `active` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
