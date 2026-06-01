// App.jsx — root component. Loads /api/sessions, renders FilterBar + Board,
// subscribes to the SSE stream and reconciles live updates (session.added/
// updated/removed and store.changed). Holds filter state and the modals.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import FilterBar from './components/FilterBar.jsx';
import Board from './components/Board.jsx';
import ColumnEditor from './components/ColumnEditor.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';

const DEFAULT_FILTERS = {
  project: '',
  model: '',
  days: 0, // 0 = always
  search: '',
  showArchived: false,
};

/**
 * Merge a store's overlay into a SessionMeta so each card carries columnId,
 * order, archived and lastDoneActivity. Used when reconciling a live session
 * against the current columns/overlay.
 */
function mergeOverlay(session, store) {
  const ov = store?.overlay?.[session.id];
  const firstCol = store?.columns?.[0]?.id ?? null;
  if (!ov) {
    return {
      ...session,
      columnId: firstCol,
      order: session.order ?? 0,
      archived: false,
      lastDoneActivity: null,
    };
  }
  return {
    ...session,
    columnId: ov.columnId ?? firstCol,
    order: ov.order ?? 0,
    archived: !!ov.archived,
    lastDoneActivity: ov.lastDoneActivity ?? null,
  };
}

export default function App() {
  const [sessions, setSessions] = useState([]); // SessionMeta merged with overlay
  const [columns, setColumns] = useState([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // session pending hard-delete

  // Keep the latest store (columns + overlay) so SSE session.* events can be
  // merged correctly without a stale closure.
  const storeRef = useRef({ columns: [], overlay: {} });

  const applyStore = useCallback((store) => {
    if (!store) return;
    storeRef.current = { columns: store.columns || [], overlay: store.overlay || {} };
    setColumns(store.columns || []);
    // Re-merge overlay onto the sessions we already hold.
    setSessions((prev) =>
      prev.map((s) => mergeOverlay(s, store)),
    );
  }, []);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, board] = await Promise.all([api.getSessions(), api.getBoard()]);
        if (cancelled) return;
        storeRef.current = {
          columns: board.columns || data.columns || [],
          overlay: board.overlay || {},
        };
        setColumns(storeRef.current.columns);
        // /api/sessions already merges overlay fields; re-merge through the same
        // client-side mergeOverlay used by the SSE path so there is a single
        // merge rule (columnId/order/archived/lastDoneActivity from the store
        // overlay, falling back to the first column).
        const merged = (data.sessions || []).map((s) => mergeOverlay(s, storeRef.current));
        setSessions(merged);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // SSE subscription for live updates.
  useEffect(() => {
    const unsub = api.subscribe((evt) => {
      if (!evt || !evt.type) return;
      switch (evt.type) {
        case 'session.added':
        case 'session.updated': {
          const merged = mergeOverlay(evt.session, {
            columns: storeRef.current.columns,
            overlay: storeRef.current.overlay,
          });
          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === merged.id);
            if (idx < 0) return [...prev, merged];
            const next = prev.slice();
            // session.updated carries a raw SessionMeta with NO authoritative
            // placement; the overlay we just merged against may be stale (e.g. a
            // live file write racing ahead of an in-flight move's store.changed).
            // So merge only the content fields and PRESERVE the placement fields
            // already held locally (columnId/order/archived/lastDoneActivity).
            // The trailing store.changed is the source of truth for placement.
            const {
              columnId: _c,
              order: _o,
              archived: _a,
              lastDoneActivity: _l,
              ...content
            } = merged;
            next[idx] = { ...next[idx], ...content };
            return next;
          });
          break;
        }
        case 'session.removed': {
          setSessions((prev) => prev.filter((s) => s.id !== evt.id));
          break;
        }
        case 'store.changed': {
          applyStore(evt.store);
          break;
        }
        default:
          break;
      }
    });
    return unsub;
  }, [applyStore]);

  const patchFilters = useCallback((patch) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  // ---- Mutations (optimistic + server reconciles via store.changed) ----

  const handleMove = useCallback(async (id, columnId, order, reordered) => {
    // Optimistic update. When the caller supplies the destination column's full
    // new ordering (`reordered`), assign sequential order values to ALL its
    // cards so the optimistic state matches what the server will renumber to
    // (contiguous 0..n-1). This avoids transient duplicate-order mis-ordering
    // (two cards sharing `order` would fall back to the lastActivity tiebreak).
    const orderById = new Map();
    if (Array.isArray(reordered)) {
      reordered.forEach((s, i) => orderById.set(s.id, i));
    }
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === id) return { ...s, columnId, order: orderById.get(id) ?? order };
        if (orderById.has(s.id) && s.columnId === columnId) {
          return { ...s, order: orderById.get(s.id) };
        }
        return s;
      }),
    );
    try {
      await api.moveCard(id, columnId, order);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const handleArchive = useCallback(async (id, archived) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, archived } : s)),
    );
    try {
      await api.archiveCard(id, archived);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const handleDeleteConfirmed = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setSessions((prev) => prev.filter((s) => s.id !== target.id));
    try {
      await api.deleteSession(target.id);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, [deleteTarget]);

  const handleAddColumn = useCallback(async (name) => {
    try {
      await api.addColumn(name);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const handleRenameColumn = useCallback(async (id, name) => {
    // optimistic local rename for snappy typing
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    try {
      await api.renameColumn(id, name);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const handleReorderColumns = useCallback(async (ids) => {
    setColumns((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      return ids.map((id, i) => ({ ...byId.get(id), order: i }));
    });
    try {
      await api.reorderColumns(ids);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const handleDeleteColumn = useCallback(async (id, moveCardsTo) => {
    try {
      await api.deleteColumn(id, moveCardsTo);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  // ---- Derived data: filter options + visible sessions ----

  const projects = useMemo(() => {
    const set = new Set();
    for (const s of sessions) if (s.projectName) set.add(s.projectName);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const models = useMemo(() => {
    const set = new Set();
    for (const s of sessions) if (s.model) set.add(s.model);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    const now = Date.now();
    const sinceMs = filters.days > 0 ? now - filters.days * 24 * 60 * 60 * 1000 : null;
    const q = filters.search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (!filters.showArchived && s.archived) return false;
      if (filters.project && s.projectName !== filters.project) return false;
      if (filters.model && s.model !== filters.model) return false;
      if (sinceMs != null) {
        const t = new Date(s.lastActivity || 0).getTime();
        if (Number.isNaN(t) || t < sinceMs) return false;
      }
      if (q && !(s.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sessions, filters]);

  const columnCounts = useMemo(() => {
    const counts = {};
    const firstCol = columns[0]?.id;
    for (const s of sessions) {
      if (s.archived) continue;
      const col = columns.some((c) => c.id === s.columnId) ? s.columnId : firstCol;
      if (col == null) continue;
      counts[col] = (counts[col] || 0) + 1;
    }
    return counts;
  }, [sessions, columns]);

  return (
    <div className="app">
      <FilterBar
        filters={filters}
        onChange={patchFilters}
        projects={projects}
        models={models}
        onOpenColumnEditor={() => setEditorOpen(true)}
        visibleCount={visibleSessions.length}
        totalCount={sessions.length}
      />

      {error ? (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="state-msg">Loading sessions…</div>
      ) : columns.length === 0 ? (
        <div className="state-msg">No columns configured.</div>
      ) : (
        <Board
          sessions={visibleSessions}
          allSessions={sessions}
          columns={columns}
          onMove={handleMove}
          onArchive={handleArchive}
          onDelete={(s) => setDeleteTarget(s)}
        />
      )}

      <ColumnEditor
        open={editorOpen}
        columns={columns}
        counts={columnCounts}
        onAdd={handleAddColumn}
        onRename={handleRenameColumn}
        onReorder={handleReorderColumns}
        onDelete={handleDeleteColumn}
        onClose={() => setEditorOpen(false)}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete permanently"
        danger
        confirmLabel="Delete from disk"
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          You are about to permanently delete the session file{' '}
          <strong>{deleteTarget?.title || deleteTarget?.id}</strong> from disk.
        </p>
        <p className="muted">
          This action is irreversible: the <code>.jsonl</code> file will be removed and all of that
          conversation's context will be lost.
        </p>
      </ConfirmModal>
    </div>
  );
}
