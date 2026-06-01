// CopyToast.test.jsx — the transient "copied" confirmation: the aria-live region
// is always present (so SR announces changes) but only carries the message text
// while `show` is true, and the useCopyToast() hook flashes then clears after the
// 2s timer (driven by fake timers).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';

import CopyToast, { useCopyToast } from '../../src/components/CopyToast.jsx';

describe('CopyToast component', () => {
  it('always renders a polite live region; shows the message only when show=true', () => {
    const { rerender } = render(<CopyToast show={false} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    rerender(<CopyToast show />);
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');

    rerender(<CopyToast show message="Custom!" />);
    expect(screen.getByRole('status')).toHaveTextContent('Custom!');
  });
});

describe('useCopyToast hook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // A tiny harness that exposes the hook's copied flag + a copy() trigger.
  function Harness({ onReady }) {
    const { copied, copy } = useCopyToast();
    useEffect(() => {
      onReady(copy);
    }, [copy, onReady]);
    return <CopyToast show={copied} />;
  }

  it('copy() shows the toast, then clears it after ~2s', async () => {
    let copyFn;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<Harness onReady={(fn) => { copyFn = fn; }} />);
    expect(screen.getByRole('status')).toHaveTextContent('');

    // Trigger a copy; flush the awaited clipboard write microtask.
    await act(async () => {
      await copyFn('some text');
    });
    expect(writeText).toHaveBeenCalledWith('some text');
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');

    // Before the 2s window elapses it is still shown.
    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');

    // After the window the toast clears itself.
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

    render(<Harness onReady={(fn) => { copyFn = fn; }} />);
    await act(async () => {
      await copyFn('text');
    });
    // The catch in copy() swallows the rejection and still flashes.
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste in your terminal');
  });
});
