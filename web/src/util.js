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
 * Format a timestamp as a relative, human-friendly Italian string
 * (e.g. "2h fa", "ieri", "adesso").
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

  // Future timestamps (clock skew / live file ahead) → treat as "adesso".
  if (diff < 0) diff = 0;

  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);

  if (sec < 45) return 'adesso';
  if (min < 1) return `${sec}s fa`;
  if (min < 60) return `${min}m fa`;
  if (hour < 24) return `${hour}h fa`;
  if (day === 1) return 'ieri';
  if (day < 7) return `${day}g fa`;
  if (day < 30) {
    const weeks = Math.floor(day / 7);
    return weeks === 1 ? '1 sett fa' : `${weeks} sett fa`;
  }
  if (day < 365) {
    const months = Math.floor(day / 30);
    return months === 1 ? '1 mese fa' : `${months} mesi fa`;
  }
  const years = Math.floor(day / 365);
  return years === 1 ? '1 anno fa' : `${years} anni fa`;
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
