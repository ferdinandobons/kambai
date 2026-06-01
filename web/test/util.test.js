// util.test.js (vitest) — tests for timeAgo() and contextColor().
// timeAgo() is always called with an explicit reference timestamp so the
// assertions are deterministic and independent of the wall clock.

import { describe, it, expect } from 'vitest';
import { timeAgo, contextColor } from '../src/util.js';

// Fixed reference "now" used across timeAgo tests.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const nowMs = NOW.getTime();
const ago = (ms) => new Date(nowMs - ms);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('timeAgo', () => {
  it('returns "just now" for very recent timestamps', () => {
    expect(timeAgo(ago(0), NOW)).toBe('just now');
    expect(timeAgo(ago(10 * SEC), NOW)).toBe('just now');
    expect(timeAgo(ago(44 * SEC), NOW)).toBe('just now');
  });

  it('formats seconds and minutes', () => {
    expect(timeAgo(ago(50 * SEC), NOW)).toBe('50s ago');
    expect(timeAgo(ago(2 * MIN), NOW)).toBe('2m ago');
    expect(timeAgo(ago(59 * MIN), NOW)).toBe('59m ago');
  });

  it('formats hours', () => {
    expect(timeAgo(ago(2 * HOUR), NOW)).toBe('2h ago');
    expect(timeAgo(ago(23 * HOUR), NOW)).toBe('23h ago');
  });

  it('formats "yesterday" and days', () => {
    expect(timeAgo(ago(1 * DAY), NOW)).toBe('yesterday');
    expect(timeAgo(ago(3 * DAY), NOW)).toBe('3d ago');
    expect(timeAgo(ago(6 * DAY), NOW)).toBe('6d ago');
  });

  it('formats weeks, months and years', () => {
    expect(timeAgo(ago(7 * DAY), NOW)).toBe('1w ago');
    expect(timeAgo(ago(14 * DAY), NOW)).toBe('2w ago');
    expect(timeAgo(ago(30 * DAY), NOW)).toBe('1mo ago');
    expect(timeAgo(ago(90 * DAY), NOW)).toBe('3mo ago');
    expect(timeAgo(ago(365 * DAY), NOW)).toBe('1y ago');
    expect(timeAgo(ago(800 * DAY), NOW)).toBe('2y ago');
  });

  it('accepts ISO strings, epoch ms and Date, and an epoch-ms reference', () => {
    expect(timeAgo(new Date(nowMs - 2 * HOUR).toISOString(), NOW)).toBe('2h ago');
    expect(timeAgo(nowMs - 2 * HOUR, nowMs)).toBe('2h ago');
    expect(timeAgo(ago(2 * HOUR), nowMs)).toBe('2h ago');
  });

  it('clamps future timestamps to "just now"', () => {
    expect(timeAgo(new Date(nowMs + 5 * MIN), NOW)).toBe('just now');
  });

  it('returns "—" for unparseable input', () => {
    expect(timeAgo(null, NOW)).toBe('—');
    expect(timeAgo('not-a-date', NOW)).toBe('—');
    expect(timeAgo(undefined, NOW)).toBe('—');
  });
});

describe('contextColor', () => {
  it('returns gray for null / undefined / NaN', () => {
    expect(contextColor(null)).toBe('var(--ctx-gray)');
    expect(contextColor(undefined)).toBe('var(--ctx-gray)');
    expect(contextColor(NaN)).toBe('var(--ctx-gray)');
  });

  it('returns green below 50', () => {
    expect(contextColor(0)).toBe('var(--ctx-green)');
    expect(contextColor(49)).toBe('var(--ctx-green)');
    expect(contextColor(49.9)).toBe('var(--ctx-green)');
  });

  it('returns amber from 50 to 80 inclusive', () => {
    expect(contextColor(50)).toBe('var(--ctx-amber)');
    expect(contextColor(65)).toBe('var(--ctx-amber)');
    expect(contextColor(80)).toBe('var(--ctx-amber)');
  });

  it('returns red above 80', () => {
    expect(contextColor(80.1)).toBe('var(--ctx-red)');
    expect(contextColor(95)).toBe('var(--ctx-red)');
    expect(contextColor(100)).toBe('var(--ctx-red)');
  });
});
