// CopyToast.jsx — a SINGLE app-level "copied to clipboard" toast.
//
// Instead of every card rendering its own aria-live region (N empty live
// regions in the DOM), one <ToastProvider> at the app root owns a single live
// region and exposes a copy() via context:
//   - useToast(): returns { copy } where copy(text) writes to the clipboard and
//     flashes the shared confirmation for ~2s.
//   - <ToastProvider>: wraps the app, renders the one live region.
//
// Pure client affordance: the only side effect is navigator.clipboard.writeText.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const COPIED_MESSAGE = 'Copied — paste in your terminal';
const VISIBLE_MS = 2000;

/**
 * Write text to the clipboard, tolerating rejection (permissions / insecure
 * context). Shared by the provider and the default (provider-less) context.
 * @param {string} text
 */
async function writeClipboard(text) {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard can reject; the caller still flashes the confirmation so the
    // affordance stays responsive.
  }
}

// Default context: still copies (so a component used without a provider works in
// isolation, e.g. unit tests), it just can't flash the shared toast.
const ToastContext = createContext({ copy: writeClipboard });

/**
 * Hook: returns { copy(text) } — writes to the clipboard and flashes the single
 * app-level toast.
 * @returns {{ copy: (text: string) => Promise<void> }}
 */
export function useToast() {
  return useContext(ToastContext);
}

/**
 * Provider holding the one shared toast. Renders a single persistent aria-live
 * region (so screen readers announce updates) and shows the bubble for ~2s after
 * each copy.
 * @param {{ children: React.ReactNode }} props
 */
export function ToastProvider({ children }) {
  const [show, setShow] = useState(false);
  const timerRef = useRef(null);

  // Clear any pending hide-timer on unmount so we never setState after unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async (text) => {
    await writeClipboard(text);
    setShow(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setShow(false);
      timerRef.current = null;
    }, VISIBLE_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ copy }}>
      {children}
      <div
        className={`copy-toast${show ? ' copy-toast-show' : ''}`}
        role="status"
        aria-live="polite"
      >
        {show ? COPIED_MESSAGE : ''}
      </div>
    </ToastContext.Provider>
  );
}
