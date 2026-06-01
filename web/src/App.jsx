// App.jsx — root component. Loads /api/sessions, renders FilterBar + Board,
// subscribes to the SSE stream and reconciles live updates (session.added/
// updated/removed and store.changed). Holds filter state and the modals.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import FilterBar from './components/FilterBar.jsx';
import Board from './components/Board.jsx';
import ColumnEditor from './components/ColumnEditor.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';
import CardDetailModal from './components/CardDetailModal.jsx';
import { useInertBackground } from './focusTrap.js';
import { isReactivated, isWorthResuming } from './util.js';

const SORT_STORAGE_KEY = 'kambai.sort';
const VALID_SORTS = ['board', 'activity', 'context', 'messages', 'created'];

/** Read the persisted sort key from localStorage, falling back to 'board'. */
function readStoredSort() {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    return VALID_SORTS.includes(v) ? v : 'board';
  } catch {
    return 'board';
  }
}

const DEFAULT_FILTERS = {
  project: '',
  model: '',
  days: 0, // 0 = always
  search: '',
  showArchived: false,
  sort: readStoredSort(), // hydrated from localStorage 'kambai.sort'
  quick: '', // active quick-filter chip ('' = none)
};

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Merge a store's overlay into a SessionMeta so each card carries columnId,
 * order, archived, lastDoneActivity and the effective title. Used when
 * reconciling a live session against the current columns/overlay.
 *
 * The effective-title rule (shared with the backend): the parsed title is the
 * "original"; a non-blank overlay `customTitle` overrides it for display, search
 * and sort. SSE delivers a raw SessionMeta (its `.title` is the original); the
 * initial load already carries `originalTitle`. Anchoring off
 * `originalTitle ?? title` makes both paths compute the same effective title.
 */
export function mergeOverlay(session, store) {
  const ov = store?.overlay?.[session.id];
  const firstCol = store?.columns?.[0]?.id ?? null;
  const base = session.originalTitle ?? session.title;
  const customTitle = ov?.customTitle ?? null;
  const title = customTitle && customTitle.trim() ? customTitle : base;
  if (!ov) {
    return {
      ...session,
      title,
      originalTitle: base,
      customTitle: null,
      columnId: firstCol,
      order: session.order ?? 0,
      archived: false,
      lastDoneActivity: null,
    };
  }
  return {
    ...session,
    title,
    originalTitle: base,
    customTitle,
    columnId: ov.columnId ?? firstCol,
    order: ov.order ?? 0,
    archived: !!ov.archived,
    lastDoneActivity: ov.lastDoneActivity ?? null,
  };
}

/**
 * Resolve the board's "done" column id from a snapshot. The server attaches an
 * authoritative `doneColumnId` to getBoard()/store.changed; mutation-route
 * snapshots may omit it, so fall back to the SAME rule the server uses (the
 * highest-`order` column) rather than keeping a divergent client definition.
 * @param {{ doneColumnId?: string|null, columns?: object[] }} snapshot
 * @returns {string|null}
 */
function resolveDoneColumnId(snapshot) {
  if (!snapshot) return null;
  if (snapshot.doneColumnId !== undefined && snapshot.doneColumnId !== null) {
    return snapshot.doneColumnId;
  }
  const cols = snapshot.columns || [];
  if (cols.length === 0) return null;
  let done = null;
  let maxOrder = -Infinity;
  for (const col of cols) {
    if ((col.order ?? 0) > maxOrder) {
      maxOrder = col.order ?? 0;
      done = col.id;
    }
  }
  return done;
}

export default function App() {
  const [sessions, setSessions] = useState([]); // SessionMeta merged with overlay
  const [columns, setColumns] = useState([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // session pending hard-delete
  const [detailId, setDetailId] = useState(null); // session id whose details modal is open
  const [liveDisconnected, setLiveDisconnected] = useState(false); // SSE stream dead

  // Capture the ?session=<id> deep-link target ONCE at first render — before the
  // URL-sync effect below runs and (with detailId still null) deletes the param.
  const [pendingDeepLink] = useState(() => {
    try {
      return new URL(window.location.href).searchParams.get('session');
    } catch {
      return null;
    }
  });

  // Keep the latest store (columns + overlay) so SSE session.* events can be
  // merged correctly without a stale closure.
  const storeRef = useRef({ columns: [], overlay: {} });

  // The authoritative "done" column id, taken from the board snapshot
  // (getBoard().doneColumnId / store.changed). This is the SINGLE definition
  // shared by client, server and the move route — no local "last column by
  // order" re-derivation. Mutation-route store.changed snapshots may omit it, so
  // we fall back to deriving it from columns (the same highest-order rule the
  // server uses) to preserve behavior across every event path.
  const [doneColumnId, setDoneColumnId] = useState(null);

  // In-flight optimistic mutations keyed by session id. Each value is a partial
  // patch (e.g. { columnId, order } or { archived } or { customTitle, title }).
  // Set before a mutation's await, cleared in its finally. applyStore re-applies
  // these on top of each merged session so a store.changed snapshot that is still
  // stale for an in-flight move/archive/rename cannot visibly revert it.
  const pendingRef = useRef(new Map());

  // Mirror of the latest `sessions` so empty-dep callbacks (handleRenameTitle)
  // can read current session fields without a stale closure or re-creation.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // The board-content wrapper, sealed inert + aria-hidden while a modal is open.
  const mainRef = useRef(null);

  // Clear the keys a just-resolved mutation owns from its in-flight patch,
  // preserving any other field a concurrent mutation may still be holding. When
  // nothing remains, drop the entry entirely. Called from each handler's finally.
  const clearPending = (id, keys) => {
    const cur = pendingRef.current.get(id);
    if (!cur) return;
    const rest = { ...cur };
    for (const k of keys) delete rest[k];
    if (Object.keys(rest).length > 0) pendingRef.current.set(id, rest);
    else pendingRef.current.delete(id);
  };

  const applyStore = useCallback((store) => {
    if (!store) return;
    storeRef.current = { columns: store.columns || [], overlay: store.overlay || {} };
    setColumns(store.columns || []);
    setDoneColumnId(resolveDoneColumnId(store));
    // Re-merge overlay onto the sessions we already hold, then re-apply any
    // in-flight optimistic patch so a stale snapshot can't undo a pending op.
    const pending = pendingRef.current;
    setSessions((prev) =>
      prev.map((s) => {
        const merged = mergeOverlay(s, store);
        const patch = pending.get(s.id);
        return patch ? { ...merged, ...patch } : merged;
      }),
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
        // The board snapshot carries the authoritative doneColumnId.
        setDoneColumnId(
          resolveDoneColumnId({
            doneColumnId: board.doneColumnId,
            columns: storeRef.current.columns,
          }),
        );
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
            //
            // The SAME staleness applies to the title override: during an
            // in-flight rename the overlay still holds the pre-PATCH customTitle
            // (null), so `merged.title`/`merged.customTitle` would clobber the
            // optimistic rename until the PATCH's store.changed lands. So we also
            // PRESERVE the locally-held customTitle. We DO refresh originalTitle
            // from the freshly parsed title (it can legitimately change, e.g. an
            // ai-title arriving later) and recompute the effective title locally:
            // a non-blank local customTitle still wins, otherwise the new
            // original shows through.
            const {
              columnId: _c,
              order: _o,
              archived: _a,
              lastDoneActivity: _l,
              title: _t,
              customTitle: _ct,
              originalTitle,
              ...content
            } = merged;
            const local = next[idx];
            const custom = local.customTitle;
            const title = custom && custom.trim() ? custom : originalTitle;
            next[idx] = {
              ...local,
              ...content,
              originalTitle,
              customTitle: custom,
              title,
            };
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
        case 'connection.open': {
          setLiveDisconnected(false);
          break;
        }
        case 'connection.error': {
          // Only surface a banner for a permanent (CLOSED) disconnect; transient
          // errors auto-reconnect and clear via connection.open.
          if (evt.fatal) setLiveDisconnected(true);
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

  // Persist the sort key whenever it changes, so it survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, filters.sort);
    } catch {
      // localStorage may be unavailable (private mode / disabled); ignore.
    }
  }, [filters.sort]);

  // Deep links: reflect the open detail card in the URL as ?session=<id> using
  // the History API only (no reload, no router dep). Clear it when the modal
  // closes. replaceState keeps the back button behavior unchanged.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (detailId) url.searchParams.set('session', detailId);
      else url.searchParams.delete('session');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // Non-browser env or blocked history API; ignore.
    }
  }, [detailId]);

  // On first load (after sessions arrive), open the modal for ?session=<uuid>
  // when such a session exists. Guarded by a ref so it only fires once.
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current || loading) return;
    deepLinkApplied.current = true;
    // Use the param captured at first render (pendingDeepLink); re-reading the URL
    // here would find it already cleared by the sync effect above.
    const param = pendingDeepLink;
    if (param && UUID_RE.test(param) && sessions.some((s) => s.id === param)) {
      setDetailId(param);
    }
  }, [loading, sessions, pendingDeepLink]);

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
    const movedOrder = orderById.get(id) ?? order;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === id) return { ...s, columnId, order: movedOrder };
        if (orderById.has(s.id) && s.columnId === columnId) {
          return { ...s, order: orderById.get(s.id) };
        }
        return s;
      }),
    );
    // Mark the moved card in-flight so a concurrent store.changed snapshot (still
    // showing the old placement) cannot revert it before this POST resolves.
    // Merge with any existing in-flight patch (e.g. an archive/rename racing this
    // move) so neither side's optimistic fields are dropped by a stale snapshot.
    const prevPatch = pendingRef.current.get(id) || {};
    pendingRef.current.set(id, { ...prevPatch, columnId, order: movedOrder });
    try {
      await api.moveCard(id, columnId, order);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      // Clear ONLY the keys this move owns, preserving any field a concurrent
      // archive/rename may still be holding (aligns with the archive/rename
      // handlers; a bare delete(id) would wipe their patch).
      clearPending(id, ['columnId', 'order']);
    }
  }, []);

  const handleArchive = useCallback(async (id, archived) => {
    // Capture the pre-toggle value so a FAILED archive PATCH can roll back.
    const prevArchived = sessionsRef.current.find((s) => s.id === id)?.archived ?? false;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, archived } : s)),
    );
    // Merge with any existing in-flight patch (e.g. an archive during a move) so
    // neither optimistic field is dropped by a stale store.changed snapshot.
    const prevPatch = pendingRef.current.get(id) || {};
    pendingRef.current.set(id, { ...prevPatch, archived });
    try {
      await api.archiveCard(id, archived);
    } catch (e) {
      setError(e.message || String(e));
      // Roll back the optimistic archive flip so a failed PATCH does not leave
      // the card in a state the server never confirmed.
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, archived: prevArchived } : s)),
      );
    } finally {
      clearPending(id, ['archived']);
    }
  }, []);

  const handleRenameTitle = useCallback(async (id, title) => {
    // Optimistically apply the effective-title rule locally: a blank override
    // resets the card to its parsed original; otherwise the override wins.
    // Compute the effective title up front from the CURRENT session (read via a
    // ref, not a stale closure) so both the optimistic state and the in-flight
    // patch carry the same computed value — a React-18 functional updater runs
    // during reconciliation, so anything assigned inside it is not available here.
    const trimmed = title.trim();
    const cur = sessionsRef.current.find((s) => s.id === id);
    const base = cur?.originalTitle ?? cur?.title;
    const optimisticTitle = trimmed || base;
    // Capture the pre-rename title/customTitle so a FAILED PATCH can roll back —
    // otherwise the optimistic title sticks with no server snapshot to correct it.
    const prevTitle = cur?.title;
    const prevCustomTitle = cur?.customTitle ?? null;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        return {
          ...s,
          title: optimisticTitle,
          customTitle: trimmed || null,
        };
      }),
    );
    // Hold the optimistic title/customTitle in-flight so a stale store.changed
    // (overlay still pre-PATCH) can't revert the rename before it resolves.
    const prevPatch = pendingRef.current.get(id) || {};
    pendingRef.current.set(id, {
      ...prevPatch,
      title: optimisticTitle,
      customTitle: trimmed || null,
    });
    try {
      await api.setTitle(id, title);
    } catch (e) {
      setError(e.message || String(e));
      // Roll back the optimistic rename to the captured pre-rename values so a
      // failed PATCH does not leave a stale title the UI never corrects.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, title: prevTitle, customTitle: prevCustomTitle } : s,
        ),
      );
    } finally {
      clearPending(id, ['title', 'customTitle']);
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
    const sinceMs = filters.days > 0 ? now - filters.days * DAY_MS : null;
    const q = filters.search.trim().toLowerCase();

    // Quick-filter chip predicate, evaluated with a single `now` per recompute.
    const quickMatch = (s) => {
      switch (filters.quick) {
        case 'worth':
          return isWorthResuming(s, { doneColumnId, nowMs: now });
        case 'high':
          return (s.contextPct ?? 0) > 80;
        case 'recent': {
          const t = new Date(s.lastActivity || 0).getTime();
          return !Number.isNaN(t) && now - t <= 7 * DAY_MS;
        }
        case 'reactivated':
          return isReactivated(s);
        default:
          return true;
      }
    };

    return sessions.filter((s) => {
      if (!filters.showArchived && s.archived) return false;
      if (filters.project && s.projectName !== filters.project) return false;
      if (filters.model && s.model !== filters.model) return false;
      if (sinceMs != null) {
        const t = new Date(s.lastActivity || 0).getTime();
        if (Number.isNaN(t) || t < sinceMs) return false;
      }
      if (q) {
        // Match the effective title OR the original parsed title, so renaming a
        // card doesn't make text from its original prompt unsearchable.
        const hay = `${s.title || ''} ${s.originalTitle || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (!quickMatch(s)) return false;
      return true;
    });
  }, [sessions, filters, doneColumnId]);

  // Count of non-archived sessions worth resuming (badge on the "worth" chip).
  const worthCount = useMemo(() => {
    const now = Date.now();
    return sessions.reduce(
      (n, s) => n + (!s.archived && isWorthResuming(s, { doneColumnId, nowMs: now }) ? 1 : 0),
      0,
    );
  }, [sessions, doneColumnId]);

  // Resolve the open detail card from live state by id so the modal reflects
  // updates (renames, archive toggles, context changes) while it is open.
  const detailSession = useMemo(
    () => (detailId == null ? null : sessions.find((s) => s.id === detailId) || null),
    [detailId, sessions],
  );

  // If the open session disappears (deleted, or its file unlinked) while the
  // modal is open, the modal unmounts but detailId would otherwise stay set,
  // leaving a stale ?session=<id> in the URL. Clear it so the deep-link param
  // matches reality. Guard with !loading so the initial deep-link id isn't
  // clobbered before sessions have arrived.
  useEffect(() => {
    if (detailId && !detailSession && !loading) setDetailId(null);
  }, [detailId, detailSession, loading]);

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

  // Seal the board behind any open modal so SR/Tab can't reach it (the modals
  // render outside .app-main, so they stay reachable with their own focus trap).
  const anyModalOpen = !!detailSession || editorOpen || !!deleteTarget;
  useInertBackground(anyModalOpen, () => mainRef.current);

  return (
    <div className="app">
      {/* Everything behind the modals. While any modal is open this wrapper is
          marked inert + aria-hidden (useInertBackground) so SR/Tab can't reach
          the board behind the dialog; the modals live OUTSIDE it, after the close
          tag, so they stay reachable and keep their own focus trap. */}
      <div className="app-main" ref={mainRef}>
        <FilterBar
          filters={filters}
          onChange={patchFilters}
          projects={projects}
          models={models}
          onOpenColumnEditor={() => setEditorOpen(true)}
          visibleCount={visibleSessions.length}
          totalCount={sessions.length}
          worthCount={worthCount}
        />

        {error ? (
          <div className="banner banner-error" role="alert">
            <span>{error}</span>
            <button type="button" className="icon-btn" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        ) : null}

        {liveDisconnected ? (
          <div className="banner banner-warn" role="status">
            <span>Live updates disconnected — the board may be out of date. Refresh to reconnect.</span>
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
            sortKey={filters.sort}
            onMove={handleMove}
            onOpen={(s) => setDetailId(s.id)}
            onArchive={handleArchive}
            onDelete={(s) => setDeleteTarget(s)}
          />
        )}
      </div>

      {detailSession ? (
        <CardDetailModal
          session={detailSession}
          onClose={() => setDetailId(null)}
          onRename={handleRenameTitle}
          onArchive={handleArchive}
          onDelete={(s) => {
            // Reuse the app's permanent-delete confirm flow, and close the
            // detail modal so the confirm dialog is unobstructed.
            setDetailId(null);
            setDeleteTarget(s);
          }}
        />
      ) : null}

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
