// FilterBar.test.jsx — the previously-untested interactive filter controls. Each
// control merge-patches the filter state through onChange; the quick-filter chips
// toggle (set on click, clear on re-click, aria-pressed reflecting active); the
// "worth" chip carries the worthCount badge while the others don't; and the
// visible/total count hides the "/total" suffix when the two are equal.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import FilterBar from '../../src/components/FilterBar.jsx';

const DEFAULT_FILTERS = {
  project: '',
  model: '',
  days: 0,
  search: '',
  showArchived: false,
  sort: 'board',
  quick: '',
};

/** Render FilterBar with overridable filters/props and a spy onChange. */
function renderBar({ filters = {}, ...props } = {}) {
  const onChange = vi.fn();
  const onOpenColumnEditor = vi.fn();
  render(
    <FilterBar
      filters={{ ...DEFAULT_FILTERS, ...filters }}
      onChange={onChange}
      projects={['kambai', 'other-proj']}
      models={['claude-opus-4-8', 'claude-haiku-4']}
      onOpenColumnEditor={onOpenColumnEditor}
      {...props}
    />,
  );
  return { onChange, onOpenColumnEditor };
}

describe('FilterBar controls patch the right field', () => {
  it('typing in search patches { search }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.type(screen.getByLabelText('Search session titles'), 'x');
    expect(onChange).toHaveBeenLastCalledWith({ search: 'x' });
  });

  it('selecting a project patches { project }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.selectOptions(screen.getByLabelText('Filter by project'), 'other-proj');
    expect(onChange).toHaveBeenCalledWith({ project: 'other-proj' });
  });

  it('selecting a model patches { model }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    // Option labels strip the leading "claude-"; the option VALUE is the full id.
    await user.selectOptions(screen.getByLabelText('Filter by model'), 'claude-haiku-4');
    expect(onChange).toHaveBeenCalledWith({ model: 'claude-haiku-4' });
  });

  it('selecting a date range patches { days } as a Number', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.selectOptions(screen.getByLabelText('Date range'), '7 days');
    expect(onChange).toHaveBeenCalledWith({ days: 7 });
    // Asserted as a number, not the string "7" the <option> value carries.
    expect(onChange.mock.calls.at(-1)[0].days).toBe(7);
  });

  it('selecting a sort patches { sort }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.selectOptions(screen.getByLabelText('Sort by'), 'Last activity');
    expect(onChange).toHaveBeenCalledWith({ sort: 'activity' });
  });

  it('toggling Show archived patches { showArchived } with the checkbox state', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.click(screen.getByLabelText('Show archived'));
    expect(onChange).toHaveBeenLastCalledWith({ showArchived: true });
  });

  it('the Columns button invokes onOpenColumnEditor', async () => {
    const user = userEvent.setup();
    const { onOpenColumnEditor } = renderBar();
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    expect(onOpenColumnEditor).toHaveBeenCalledTimes(1);
  });
});

describe('FilterBar quick-filter chips', () => {
  it('clicking an inactive chip sets { quick } to that value', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();
    await user.click(screen.getByRole('button', { name: /High context/i }));
    expect(onChange).toHaveBeenCalledWith({ quick: 'high' });
  });

  it('re-clicking the ACTIVE chip clears it (sets { quick: "" })', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar({ filters: { quick: 'high' } });
    await user.click(screen.getByRole('button', { name: /High context/i }));
    expect(onChange).toHaveBeenCalledWith({ quick: '' });
  });

  it('aria-pressed reflects which chip is active', () => {
    renderBar({ filters: { quick: 'recent' } });
    expect(screen.getByRole('button', { name: /Recent 7d/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /High context/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('the worthCount badge appears ONLY on the "worth" chip', () => {
    renderBar({ worthCount: 4 });
    const group = screen.getByRole('group', { name: /Quick filters/i });
    // The worth chip carries the count in parentheses.
    expect(within(group).getByRole('button', { name: /Worth resuming \(4\)/i })).toBeInTheDocument();
    // No other chip shows a "(N)" badge.
    expect(within(group).getByRole('button', { name: 'High context' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Recent 7d' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Reactivated' })).toBeInTheDocument();
  });

  it('the worth chip shows (0) when no sessions are worth resuming', () => {
    renderBar();
    expect(
      screen.getByRole('button', { name: /Worth resuming \(0\)/i }),
    ).toBeInTheDocument();
  });
});

describe('FilterBar visible/total count', () => {
  it('shows "N/M sessions" when visible differs from total', () => {
    renderBar({ visibleCount: 3, totalCount: 10 });
    expect(screen.getByText(/3\/10\s*sessions/)).toBeInTheDocument();
  });

  it('hides the "/total" suffix when visible equals total', () => {
    renderBar({ visibleCount: 10, totalCount: 10 });
    const count = screen.getByText(/sessions/);
    expect(count).toHaveTextContent(/^10\s*sessions$/);
    expect(count).not.toHaveTextContent('/');
  });

  it('renders nothing for the count when visibleCount is not a number', () => {
    renderBar({ totalCount: 10 });
    expect(screen.queryByText(/sessions/)).not.toBeInTheDocument();
  });
});
