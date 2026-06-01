// CardDetailModal.test.jsx — the editable-title flow (Save / Reset to original),
// the Resume copy-to-clipboard, and archive/delete/close wiring.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import CardDetailModal from '../../src/components/CardDetailModal.jsx';

function makeSession(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Effective title',
    originalTitle: 'Parsed original',
    customTitle: null,
    projectName: 'kambai',
    projectPath: '/Users/me/my proj',
    gitBranch: 'main',
    model: 'claude-opus-4-8',
    contextPct: 42,
    contextTokens: 12345,
    messageCount: 7,
    lastActivity: '2026-06-01T10:00:00.000Z',
    createdAt: '2026-05-30T09:00:00.000Z',
    lastPrompt: 'do the thing',
    archived: false,
    ...overrides,
  };
}

let clipboardWrite;
beforeEach(() => {
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  // jsdom has no clipboard by default; define a writable mock.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWrite },
    configurable: true,
    writable: true,
  });
});

describe('CardDetailModal rename', () => {
  it('Save is disabled until the draft differs, then calls onRename with the new title', async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    render(<CardDetailModal session={makeSession()} onRename={onRename} onClose={() => {}} />);

    const input = screen.getByLabelText('Session title');
    expect(input).toHaveValue('Effective title');

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // draft === effective title

    await user.clear(input);
    await user.type(input, 'Renamed');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onRename).toHaveBeenCalledWith(makeSession().id, 'Renamed');
  });

  it('Enter in the title input saves (and does not submit a form/reload)', async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    render(<CardDetailModal session={makeSession()} onRename={onRename} onClose={() => {}} />);

    const input = screen.getByLabelText('Session title');
    await user.clear(input);
    await user.type(input, 'Via enter{Enter}');
    expect(onRename).toHaveBeenCalledWith(makeSession().id, 'Via enter');
  });

  it('shows the original + "Reset to original" only when a custom title is set; Reset calls onRename("")', async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    const session = makeSession({
      title: 'Custom name',
      customTitle: 'Custom name',
      originalTitle: 'Parsed original',
    });
    render(<CardDetailModal session={session} onRename={onRename} onClose={() => {}} />);

    expect(screen.getByText('Parsed original')).toBeInTheDocument();
    const reset = screen.getByRole('button', { name: /Reset to original/i });
    await user.click(reset);
    expect(onRename).toHaveBeenCalledWith(session.id, '');
  });

  it('hides the Reset affordance when there is no custom title', () => {
    render(<CardDetailModal session={makeSession()} onRename={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /Reset to original/i })).not.toBeInTheDocument();
  });
});

describe('CardDetailModal Resume copy', () => {
  it('copies the resume command (with cd into a quoted project path) and flashes the toast', async () => {
    const user = userEvent.setup();
    // user-event v14 installs its OWN clipboard stub in setup(); re-install ours
    // AFTER setup so the component's writeText hits the spy we assert on.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
      writable: true,
    });
    const session = makeSession({ projectPath: '/Users/me/my proj' });
    render(<CardDetailModal session={session} onRename={() => {}} onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const written = clipboardWrite.mock.calls[0][0];
    expect(written).toBe(`cd '/Users/me/my proj' && claude --resume ${session.id}`);

    // The toast becomes visible (aria-live region populated).
    expect(await screen.findByText(/Copied — paste in your terminal/i)).toBeInTheDocument();
  });
});

describe('CardDetailModal footer actions', () => {
  it('Archive toggles via onArchive with the inverted flag', async () => {
    const onArchive = vi.fn();
    const user = userEvent.setup();
    const session = makeSession({ archived: false });
    render(
      <CardDetailModal session={session} onArchive={onArchive} onRename={() => {}} onClose={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith(session.id, true);
  });

  it('shows "Restore" for an archived session and inverts back to false', async () => {
    const onArchive = vi.fn();
    const user = userEvent.setup();
    const session = makeSession({ archived: true });
    render(
      <CardDetailModal session={session} onArchive={onArchive} onRename={() => {}} onClose={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onArchive).toHaveBeenCalledWith(session.id, false);
  });

  it('Delete calls onDelete with the session; Close + Escape call onClose', async () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const session = makeSession();
    render(
      <CardDetailModal
        session={session}
        onDelete={onDelete}
        onClose={onClose}
        onRename={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(session);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders a labelled modal dialog', () => {
    render(<CardDetailModal session={makeSession()} onRename={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /Session details/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
