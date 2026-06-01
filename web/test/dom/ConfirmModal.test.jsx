// ConfirmModal.test.jsx — the generic confirm dialog. The destructive variant
// (danger) is an `alertdialog` so screen readers announce it as an alert, while
// the default variant stays a plain `dialog`. Also pins the confirm/cancel/Escape
// wiring and the focus-the-primary-on-open behavior.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ConfirmModal from '../../src/components/ConfirmModal.jsx';

function renderModal(props = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmModal
      open
      title="Delete permanently"
      confirmLabel="Delete from disk"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      <p>body text</p>
    </ConfirmModal>,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmModal role', () => {
  it('a danger modal uses role="alertdialog"', () => {
    renderModal({ danger: true });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete permanently' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // It is NOT exposed as a plain dialog.
    expect(screen.queryByRole('dialog', { name: 'Delete permanently' })).not.toBeInTheDocument();
    // The destructive body is announced assertively.
    expect(dialog.querySelector('.modal-body')).toHaveAttribute('aria-live', 'assertive');
  });

  it('a non-danger modal stays a plain role="dialog"', () => {
    renderModal({ danger: false });
    expect(screen.getByRole('dialog', { name: 'Delete permanently' })).toBeInTheDocument();
    expect(
      screen.queryByRole('alertdialog', { name: 'Delete permanently' }),
    ).not.toBeInTheDocument();
    // No assertive live region on a non-destructive body.
    const dialog = screen.getByRole('dialog', { name: 'Delete permanently' });
    expect(dialog.querySelector('.modal-body')).not.toHaveAttribute('aria-live');
  });

  it('renders nothing when open is false', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ConfirmModal wiring', () => {
  it('focuses the primary (confirm) button on open', () => {
    renderModal({ danger: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Delete from disk' }),
    );
  });

  it('the confirm button calls onConfirm; Cancel calls onCancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderModal({ danger: true });
    await user.click(screen.getByRole('button', { name: 'Delete from disk' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderModal({ danger: true });
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter confirms only when the confirm button is the active element', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ danger: true });
    // The confirm button is focused on open → Enter on it confirms.
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
