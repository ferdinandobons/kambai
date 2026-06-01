// CopyToast.jsx — a tiny shared "copied to clipboard" confirmation.
//
// Two pieces:
//   - useCopyToast(): a hook that exposes { copied, copy } where `copy(text)`
//     writes to the clipboard and flashes a transient confirmation for ~2s.
//   - <CopyToast show message />: an aria-live region that renders the
//     confirmation text only while `show` is true, so screen readers announce it.
//
// Pure client affordance: the only side effect is navigator.clipboard.writeText.

import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_MESSAGE = 'Copied — paste in your terminal';
const VISIBLE_MS = 2000;

/**
 * Hook providing a transient "copied" confirmation around a clipboard write.
 * @returns {{ copied: boolean, copy: (text: string) => Promise<void> }}
 */
export function useCopyToast() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  // Clear any pending hide-timer on unmount so we never setState after unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flash = useCallback(() => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, VISIBLE_MS);
  }, []);

  const copy = useCallback(
    async (text) => {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        // Clipboard can reject (permissions / insecure context); still flash the
        // confirmation so the affordance stays responsive — the text is shown so
        // the user can copy it manually if needed.
      }
      flash();
    },
    [flash],
  );

  return { copied, copy };
}

/**
 * Transient, screen-reader-announced confirmation. Always renders the live
 * region (so updates are announced); the visible bubble only appears while
 * `show` is true.
 *
 * @param {Object} props
 * @param {boolean} props.show
 * @param {string} [props.message]
 * @param {string} [props.className] - extra classes for positioning.
 * @returns {JSX.Element}
 */
export default function CopyToast({ show, message = COPIED_MESSAGE, className = '' }) {
  return (
    <div className={`copy-toast${show ? ' copy-toast-show' : ''}${className ? ` ${className}` : ''}`} role="status" aria-live="polite">
      {show ? message : ''}
    </div>
  );
}
