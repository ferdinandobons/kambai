// Card.test.jsx — the card's actions menu (Copy resume command / Archive /
// Delete) and the a11y structure (aria-haspopup/expanded menu button, role=menu
// with role=menuitem children, dedicated keyboard "Open details" affordance).
// We render the presentational CardView (no useSortable), which carries the full
// markup and menu logic without needing a DndContext.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CardView } from '../../src/components/Card.jsx';
import { ToastProvider } from '../../src/components/CopyToast.jsx';

function makeSession(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'My card',
    projectName: 'kanbai',
    projectPath: '/Users/me/proj',
    gitBranch: 'main',
    model: 'claude-opus-4-8',
    contextPct: 42,
    messageCount: 7,
    lastActivity: '2026-06-01T10:00:00.000Z',
    archived: false,
    ...overrides,
  };
}

let clipboardWrite;
beforeEach(() => {
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
});

describe('Card menu a11y structure', () => {
  it('the actions button is a menu trigger; the menu is hidden until opened', async () => {
    const user = userEvent.setup();
    render(<CardView session={makeSession()} onOpen={() => {}} onArchive={() => {}} onDelete={() => {}} />);

    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual([
      'Copy resume command',
      'Archive',
      'Delete',
    ]);
  });

  it('exposes a dedicated, focusable "Open details" button (keyboard path)', () => {
    render(<CardView session={makeSession()} onOpen={() => {}} onArchive={() => {}} onDelete={() => {}} />);
    const open = screen.getByRole('button', { name: /Open details for My card/i });
    expect(open).toBeInTheDocument();
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<CardView session={makeSession()} onOpen={() => {}} onArchive={() => {}} onDelete={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('Card menu actions', () => {
  it('Archive calls onArchive with the inverted flag and closes the menu', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const session = makeSession({ archived: false });
    render(<CardView session={session} onOpen={() => {}} onArchive={onArchive} onDelete={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith(session.id, true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('an archived card shows "Restore" and inverts back to false', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const session = makeSession({ archived: true });
    render(<CardView session={session} onOpen={() => {}} onArchive={onArchive} onDelete={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    expect(onArchive).toHaveBeenCalledWith(session.id, false);
  });

  it('Delete calls onDelete with the session', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const session = makeSession();
    render(<CardView session={session} onOpen={() => {}} onArchive={() => {}} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(session);
  });

  it('Copy resume command writes the cd+resume command to the clipboard and flashes the toast', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
      writable: true,
    });
    const session = makeSession({ projectPath: '/Users/me/proj' });
    render(
      <ToastProvider>
        <CardView session={session} onOpen={() => {}} onArchive={() => {}} onDelete={() => {}} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy resume command' }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      `cd '/Users/me/proj' && claude --resume ${session.id}`,
    );
    expect(await screen.findByText(/Copied — paste in your terminal/i)).toBeInTheDocument();
  });
});

describe('Card body open affordance', () => {
  it('clicking the card body opens the details modal', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const session = makeSession();
    render(<CardView session={session} onOpen={onOpen} onArchive={() => {}} onDelete={() => {}} />);
    // The title lives inside the clickable body.
    await user.click(screen.getByText('My card'));
    expect(onOpen).toHaveBeenCalledWith(session);
  });

  it('clicking the dedicated "Open details" button opens the modal exactly once', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const session = makeSession();
    render(<CardView session={session} onOpen={onOpen} onArchive={() => {}} onDelete={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Open details for My card/i }));
    // stopPropagation prevents a second open from the body.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
