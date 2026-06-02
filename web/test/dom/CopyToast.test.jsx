// CopyToast.test.jsx — the single app-level "copied" toast: one persistent
// aria-live region owned by <ToastProvider>, flashed via useToast().copy(text),
// which writes to the clipboard and clears the bubble after the 2s timer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';

import { ToastProvider, useToast } from '../../src/components/CopyToast.jsx';

// A tiny child that hands its copy() back to the test.
function Harness({ onReady }) {
  const { copy } = useToast();
  useEffect(() => {
    onReady(copy);
  }, [copy, onReady]);
  return null;
}

describe('ToastProvider + useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders one persistent polite live region, empty until a copy', () => {
    render(
      <ToastProvider>
        <div>child</div>
      </ToastProvider>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
  });

  it('copy() writes to the clipboard, shows the toast, then clears after ~2s', async () => {
    let copyFn;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <ToastProvider>
        <Harness onReady={(fn) => { copyFn = fn; }} />
      </ToastProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('');

    await act(async () => {
      await copyFn('some text');
    });
    expect(writeText).toHaveBeenCalledWith('some text');
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');

    // Still shown just before the 2s window elapses.
    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');

    // Cleared after the window.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('still flashes the toast even when the clipboard write rejects', async () => {
    let copyFn;
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <ToastProvider>
        <Harness onReady={(fn) => { copyFn = fn; }} />
      </ToastProvider>,
    );
    await act(async () => {
      await copyFn('text');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');
  });
});
