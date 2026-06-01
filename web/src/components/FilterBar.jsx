// FilterBar.jsx — filters: project, date range (last N days), model, text search
// on the title, plus a "mostra archiviate" toggle. Controlled by App via the
// `filters` object and `onChange`.

/**
 * @param {Object} props
 * @param {object} props.filters - { project, days, model, search, showArchived }
 * @param {(patch: object) => void} props.onChange - merge-patches the filter state.
 * @param {string[]} props.projects - distinct project names present in the data.
 * @param {string[]} props.models - distinct model ids present in the data.
 * @param {() => void} [props.onOpenColumnEditor]
 * @param {number} [props.visibleCount]
 * @param {number} [props.totalCount]
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
}) {
  const dayOptions = [
    { value: 0, label: 'Sempre' },
    { value: 1, label: '24 ore' },
    { value: 7, label: '7 giorni' },
    { value: 30, label: '30 giorni' },
    { value: 90, label: '90 giorni' },
  ];

  return (
    <div className="filterbar">
      <div className="brand">
        <span className="brand-mark">▦</span>
        <span className="brand-name">Kambai</span>
      </div>

      <input
        type="search"
        className="filter-input filter-search"
        placeholder="Cerca nel titolo…"
        value={filters.search}
        onChange={(e) => onChange({ search: e.target.value })}
      />

      <select
        className="filter-input"
        value={filters.project}
        onChange={(e) => onChange({ project: e.target.value })}
        aria-label="Filtra per progetto"
      >
        <option value="">Tutti i progetti</option>
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
        aria-label="Filtra per modello"
      >
        <option value="">Tutti i modelli</option>
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
        aria-label="Intervallo di date"
      >
        {dayOptions.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <label className="filter-toggle">
        <input
          type="checkbox"
          checked={filters.showArchived}
          onChange={(e) => onChange({ showArchived: e.target.checked })}
        />
        <span>Mostra archiviate</span>
      </label>

      <div className="filterbar-spacer" />

      {typeof visibleCount === 'number' ? (
        <span className="filter-count">
          {visibleCount}
          {typeof totalCount === 'number' && totalCount !== visibleCount ? `/${totalCount}` : ''}{' '}
          sessioni
        </span>
      ) : null}

      <button type="button" className="btn" onClick={onOpenColumnEditor}>
        Colonne
      </button>
    </div>
  );
}
