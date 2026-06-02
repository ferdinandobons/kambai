// FilterBar.jsx — filters: project, date range (last N days), model, text search
// on the title, plus a "Show archived" toggle, a sort selector and a row of
// quick-filter chips. Controlled by App via the `filters` object and `onChange`.

const SORT_OPTIONS = [
  { value: 'board', label: 'Board order' },
  { value: 'activity', label: 'Last activity' },
  { value: 'context', label: 'Context %' },
  { value: 'messages', label: 'Messages' },
  { value: 'created', label: 'Created' },
];

const QUICK_CHIPS = [
  { value: 'worth', label: 'Worth resuming' }, // label gets the (N) count appended
  { value: 'high', label: 'High context' },
  { value: 'recent', label: 'Recent 7d' },
  { value: 'reactivated', label: 'Reactivated' },
];

/**
 * @param {Object} props
 * @param {object} props.filters - { project, days, model, search, showArchived, showAutomated, sort, quick }
 * @param {(patch: object) => void} props.onChange - merge-patches the filter state.
 * @param {string[]} props.projects - distinct project names present in the data.
 * @param {string[]} props.models - distinct model ids present in the data.
 * @param {() => void} [props.onOpenColumnEditor]
 * @param {number} [props.visibleCount]
 * @param {number} [props.totalCount]
 * @param {number} [props.worthCount] - count of sessions worth resuming (chip badge).
 * @returns {JSX.Element}
 */
export default function FilterBar({
  filters,
  onChange,
  projects = [],
  models = [],
  onOpenColumnEditor,
  visibleCount,
  totalCount,
  worthCount = 0,
}) {
  const dayOptions = [
    { value: 0, label: 'Any time' },
    { value: 1, label: '24 hours' },
    { value: 7, label: '7 days' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
  ];

  // Clicking the active chip clears it; clicking another switches to it.
  const toggleQuick = (value) => onChange({ quick: filters.quick === value ? '' : value });

  return (
    <div className="filterbar-wrap">
    <div className="filterbar">
      <div className="brand">
        <span className="brand-logo" aria-hidden="true">KAI</span>
        <span className="brand-name">Kambai</span>
      </div>

      <input
        type="search"
        className="filter-input filter-search"
        placeholder="Search titles…"
        aria-label="Search session titles"
        value={filters.search}
        onChange={(e) => onChange({ search: e.target.value })}
      />

      <select
        className="filter-input"
        value={filters.project}
        onChange={(e) => onChange({ project: e.target.value })}
        aria-label="Filter by project"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        className="filter-input"
        value={filters.model}
        onChange={(e) => onChange({ model: e.target.value })}
        aria-label="Filter by model"
      >
        <option value="">All models</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m.replace(/^claude-/, '')}
          </option>
        ))}
      </select>

      <select
        className="filter-input"
        value={String(filters.days)}
        onChange={(e) => onChange({ days: Number(e.target.value) })}
        aria-label="Date range"
      >
        {dayOptions.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <select
        className="filter-input"
        value={filters.sort}
        onChange={(e) => onChange({ sort: e.target.value })}
        aria-label="Sort by"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label className="filter-toggle">
        <input
          type="checkbox"
          checked={filters.showArchived}
          onChange={(e) => onChange({ showArchived: e.target.checked })}
        />
        <span>Show archived</span>
      </label>

      <label
        className="filter-toggle"
        title="Programmatic/agent sessions (no AI title + a JSON-payload first message)"
      >
        <input
          type="checkbox"
          checked={filters.showAutomated}
          onChange={(e) => onChange({ showAutomated: e.target.checked })}
        />
        <span>Show automated</span>
      </label>

      <div className="filterbar-spacer" />

      {typeof visibleCount === 'number' ? (
        <span className="filter-count">
          {visibleCount}
          {typeof totalCount === 'number' && totalCount !== visibleCount ? `/${totalCount}` : ''}{' '}
          sessions
        </span>
      ) : null}

      <button type="button" className="btn" onClick={onOpenColumnEditor}>
        Columns
      </button>
    </div>

    <div className="chip-row" role="group" aria-label="Quick filters">
      {QUICK_CHIPS.map((chip) => {
        const active = filters.quick === chip.value;
        const label = chip.value === 'worth' ? `${chip.label} (${worthCount})` : chip.label;
        return (
          <button
            key={chip.value}
            type="button"
            className={`chip${active ? ' chip-active' : ''}`}
            aria-pressed={active}
            onClick={() => toggleQuick(chip.value)}
          >
            {label}
          </button>
        );
      })}
    </div>
    </div>
  );
}
