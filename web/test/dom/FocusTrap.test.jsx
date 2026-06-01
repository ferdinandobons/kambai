// FocusTrap.test.jsx — the shared modal focus trap (focusTrap.js#trapTab) and its
// wiring inside ConfirmModal. Tab from the last focusable wraps to the first, and
// Shift+Tab from the first wraps to the last, so keyboard focus can never escape
// an open dialog.
//
// jsdom has no layout: every element's `offsetParent` is null, which the trap's
// visibility filter (`el.offsetParent !== null`) would treat as "not visible",
// emptying the focusable list and making the trap a no-op. That's a jsdom
// artifact, not app behavior — real browsers report a non-null offsetParent for a
// visible button. So we stub offsetParent to a non-null node on the dialog's
// buttons (test-only; the SOURCE filter is exercised exactly as written) and then
// drive the real Tab/Shift+Tab paths.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { trapTab } from '../../src/focusTrap.js';
import ConfirmModal from '../../src/components/ConfirmModal.jsx';

/** Mark every focusable in `dialog` "visible" by stubbing a non-null offsetParent
 *  (jsdom returns null for all elements, which the trap reads as hidden). */
function makeFocusablesVisible(dialog) {
  for (const el of dialog.querySelectorAll('button, input, select, textarea, [href]')) {
    Object.defineProperty(el, 'offsetParent', { value: dialog, configurable: true });
  }
}

/** Dispatch a Tab / Shift+Tab keydown on `window` (where ConfirmModal listens). */
function pressTab({ shift = false } = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }),
  );
}

describe('trapTab cycling (unit)', () => {
  function setup() {
    const { container } = render(
      <div className="modal" tabIndex={-1}>
        <button>first</button>
        <input aria-label="middle" />
        <button>last</button>
      </div>,
    );
    const dialog = container.querySelector('.modal');
    makeFocusablesVisible(dialog);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    return { dialog, first, last };
  }

  it('Tab from the last focusable wraps to the first', () => {
    const { dialog, first, last } = setup();
    last.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    trapTab(e, dialog);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    const { dialog, first, last } = setup();
    first.focus();
    const e = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    trapTab(e, dialog);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('a Tab in the MIDDLE of the list is left to the browser (no wrap, no preventDefault)', () => {
    const { dialog } = setup();
    screen.getByLabelText('middle').focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    trapTab(e, dialog);
    expect(e.defaultPrevented).toBe(false);
  });

  it('is a no-op for non-Tab keys and a null dialog', () => {
    const { dialog } = setup();
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    expect(() => trapTab(e, dialog)).not.toThrow();
    expect(e.defaultPrevented).toBe(false);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    expect(() => trapTab(tab, null)).not.toThrow();
    expect(tab.defaultPrevented).toBe(false);
  });
});

describe('ConfirmModal focus trap (wired end-to-end)', () => {
  it('cycles Tab/Shift+Tab between Cancel and Confirm without escaping the dialog', () => {
    render(
      <ConfirmModal
        open
        title="Trap me"
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Trap me' });
    makeFocusablesVisible(dialog);

    const cancel = screen.getByRole('button', { name: 'Cancel' }); // first focusable
    const confirm = screen.getByRole('button', { name: 'Confirm' }); // last focusable
    // ConfirmModal focuses the primary (Confirm) on open.
    expect(document.activeElement).toBe(confirm);

    // Tab from the last (Confirm) wraps to the first (Cancel).
    pressTab();
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab from the first (Cancel) wraps back to the last (Confirm).
    pressTab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });
});
