// util.js — pure, testable helpers used across the UI.
// No DOM / browser globals here so the functions stay deterministic and unit-testable.

/**
 * Coerce a flexible timestamp into epoch milliseconds.
 * Accepts an ISO string, an epoch-ms number, or a Date.
 * @param {string|number|Date} when
 * @returns {number|null} epoch ms, or null when unparseable.
 */
function toMillis(when) {
  if (when == null) return null;
  if (when instanceof Date) {
    const t = when.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof when === 'number') {
    return Number.isFinite(when) ? when : null;
  }
  const t = new Date(when).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Format a timestamp as a relative, human-friendly English string
 * (e.g. "2h ago", "yesterday", "just now").
 *
 * @param {string|number|Date} when - ISO string, epoch ms, or Date.
 * @param {Date|number} [now] - Reference "now" (defaults to current time);
 *   injectable for deterministic tests. May be a Date or epoch ms.
 * @returns {string}
 */
export function timeAgo(when, now) {
  const then = toMillis(when);
  if (then == null) return '—';

  const ref = now == null ? Date.now() : toMillis(now);
  if (ref == null) return '—';

  let diff = ref - then; // ms; positive = in the past

  // Future timestamps (clock skew / live file ahead) → treat as "just now".
  if (diff < 0) diff = 0;

  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);

  if (sec < 45) return 'just now';
  if (min < 1) return `${sec}s ago`;
  if (min < 60) return `${min}m ago`;
  if (hour < 24) return `${hour}h ago`;
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  if (day < 30) {
    const weeks = Math.floor(day / 7);
    return weeks === 1 ? '1w ago' : `${weeks}w ago`;
  }
  if (day < 365) {
    const months = Math.floor(day / 30);
    return months === 1 ? '1mo ago' : `${months}mo ago`;
  }
  const years = Math.floor(day / 365);
  return years === 1 ? '1y ago' : `${years}y ago`;
}

/**
 * Map a context-usage percentage to a color band:
 *   green  (<50), amber (50–80), red (>80), gray when null/unknown.
 *
 * @param {number|null|undefined} pct
 * @returns {string} A CSS color token (CSS custom property reference).
 */
export function contextColor(pct) {
  if (pct == null || Number.isNaN(pct)) return 'var(--ctx-gray)';
  if (pct < 50) return 'var(--ctx-green)';
  if (pct <= 80) return 'var(--ctx-amber)';
  return 'var(--ctx-red)';
}

/**
 * Has this card been "reactivated"? True when new activity arrived after the
 * card was last moved into a done column (lastActivity > lastDoneActivity).
 * Compares via parsed timestamps; returns false when either is missing/unparseable.
 *
 * @param {object} session - SessionMeta merged with overlay fields.
 * @returns {boolean}
 */
export function isReactivated(session) {
  if (!session) return false;
  const done = toMillis(session.lastDoneActivity);
  const last = toMillis(session.lastActivity);
  if (done == null || last == null) return false;
  return last > done;
}

/**
 * Build the shell command that resumes a session in Claude.
 * Prefixes a `cd <projectPath>` when the session carries one.
 *
 * @param {object} session - SessionMeta (uses id and projectPath).
 * @returns {string}
 */
export function resumeCommand(session) {
  const id = session?.id ?? '';
  const path = session?.projectPath;
  const resume = `claude --resume ${id}`;
  // Single-quote the path so it survives paste into a shell when it contains
  // spaces or other shell-significant characters. Escape any embedded single
  // quotes with the standard '\'' idiom (close quote, escaped quote, reopen).
  return path ? `cd '${String(path).replace(/'/g, "'\\''")}' && ${resume}` : resume;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recency boost used by resumeScore: a session touched recently is more worth
 * resuming. Buckets by age relative to `nowMs`.
 *
 * @param {string|number|Date} lastActivity
 * @param {number} nowMs - reference "now" as epoch ms (callers pass this so the
 *   function is deterministic / unit-testable — it never reads the clock).
 * @returns {number} 30 (≤1d), 20 (≤3d), 10 (≤7d), else 0.
 */
function recencyBoost(lastActivity, nowMs) {
  const last = toMillis(lastActivity);
  if (last == null) return 0;
  const ageMs = nowMs - last;
  if (ageMs <= DAY_MS) return 30;
  if (ageMs <= 3 * DAY_MS) return 20;
  if (ageMs <= 7 * DAY_MS) return 10;
  return 0;
}

/**
 * Score how worth-resuming a session is (higher = more worth resuming).
 * Archived and done-column sessions always score 0.
 *
 * leverage = (contextPct || 0)
 *          + recencyBoost(lastActivity vs nowMs)
 *          + (isReactivated ? 25 : 0)
 *
 * @param {object} session
 * @param {{ doneColumnId: string|null, nowMs: number }} opts - callers pass an
 *   explicit `nowMs` epoch so the score is deterministic / unit-testable.
 * @returns {number}
 */
export function resumeScore(session, { doneColumnId, nowMs } = {}) {
  if (!session) return 0;
  if (session.archived || session.columnId === doneColumnId) return 0;
  const base = session.contextPct || 0;
  return base + recencyBoost(session.lastActivity, nowMs) + (isReactivated(session) ? 25 : 0);
}

/**
 * Quick predicate: is this session worth resuming at all? True when it is NOT
 * archived AND not in the done column AND any of:
 *   - context usage is at least 50%
 *   - it has been reactivated
 *   - its last activity is within 2 days of nowMs
 *
 * @param {object} session
 * @param {{ doneColumnId: string|null, nowMs: number }} opts - explicit `nowMs`
 *   epoch keeps this deterministic / unit-testable.
 * @returns {boolean}
 */
export function isWorthResuming(session, { doneColumnId, nowMs } = {}) {
  if (!session) return false;
  if (session.archived) return false;
  if (session.columnId === doneColumnId) return false;
  if ((session.contextPct ?? 0) >= 50) return true;
  if (isReactivated(session)) return true;
  const last = toMillis(session.lastActivity);
  if (last != null && nowMs - last <= 2 * DAY_MS) return true;
  return false;
}

/**
 * Build a comparator(a, b) for sorting sessions by a named key. Used by the
 * Board to lay out each column's cards.
 *
 *   board    — by (order asc) then (lastActivity desc): the EXISTING column
 *              behavior.
 *   activity — lastActivity desc.
 *   context  — contextPct desc (null/undefined sort last).
 *   messages — messageCount desc.
 *   created  — createdAt desc.
 *
 * Unknown keys fall back to 'board'.
 *
 * @param {'board'|'activity'|'context'|'messages'|'created'} sortKey
 * @returns {(a: object, b: object) => number}
 */
export function sessionComparator(sortKey) {
  const lastActivityDesc = (a, b) =>
    (toMillis(b.lastActivity) ?? 0) - (toMillis(a.lastActivity) ?? 0);

  switch (sortKey) {
    case 'activity':
      return lastActivityDesc;
    case 'context':
      return (a, b) => {
        // null/undefined contextPct sort last regardless of direction.
        const av = a.contextPct;
        const bv = b.contextPct;
        const aNull = av == null;
        const bNull = bv == null;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        return bv - av;
      };
    case 'messages':
      return (a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0);
    case 'created':
      return (a, b) => (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0);
    case 'board':
    default:
      return (a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return lastActivityDesc(a, b);
      };
  }
}
