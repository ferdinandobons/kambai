// resume.test.js (vitest) — tests for the resume/sort helpers in util.js:
// resumeCommand, resumeScore, isWorthResuming and sessionComparator.
//
// Every time-dependent helper is called with an explicit `nowMs` epoch so the
// assertions are deterministic and independent of the wall clock. Runs under the
// `node` environment (no DOM): all of these are pure functions.

import { describe, it, expect } from 'vitest';
import {
  isReactivated,
  resumeCommand,
  resumeScore,
  isWorthResuming,
  sessionComparator,
} from '../src/util.js';

// Fixed reference "now".
const NOW = new Date('2026-06-01T12:00:00.000Z');
const nowMs = NOW.getTime();
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(nowMs - ms).toISOString();

const DONE = 'col-done';

describe('isReactivated', () => {
  it('is true when lastActivity is after lastDoneActivity', () => {
    expect(
      isReactivated({ lastActivity: ago(0), lastDoneActivity: ago(DAY) }),
    ).toBe(true);
  });

  it('is false when lastActivity is at/before lastDoneActivity', () => {
    expect(
      isReactivated({ lastActivity: ago(DAY), lastDoneActivity: ago(0) }),
    ).toBe(false);
    expect(
      isReactivated({ lastActivity: ago(DAY), lastDoneActivity: ago(DAY) }),
    ).toBe(false);
  });

  it('is false when either timestamp is missing/unparseable', () => {
    expect(isReactivated({ lastActivity: ago(0) })).toBe(false);
    expect(isReactivated({ lastDoneActivity: ago(0) })).toBe(false);
    expect(isReactivated({})).toBe(false);
    expect(isReactivated(null)).toBe(false);
    expect(
      isReactivated({ lastActivity: 'nope', lastDoneActivity: ago(0) }),
    ).toBe(false);
  });
});

describe('resumeCommand', () => {
  it('prefixes a single-quoted cd when projectPath is present', () => {
    expect(
      resumeCommand({ id: 'abc-123', projectPath: '/home/me/proj' }),
    ).toBe("cd '/home/me/proj' && claude --resume abc-123");
  });

  it('quotes paths with spaces so the copied command pastes correctly', () => {
    expect(
      resumeCommand({ id: 'abc-123', projectPath: '/Users/me/My Project' }),
    ).toBe("cd '/Users/me/My Project' && claude --resume abc-123");
  });

  it("escapes embedded single quotes in the path", () => {
    expect(
      resumeCommand({ id: 'abc-123', projectPath: "/Users/me/o'brien" }),
    ).toBe("cd '/Users/me/o'\\''brien' && claude --resume abc-123");
  });

  it('omits the cd when projectPath is absent', () => {
    expect(resumeCommand({ id: 'abc-123' })).toBe('claude --resume abc-123');
    expect(resumeCommand({ id: 'abc-123', projectPath: '' })).toBe(
      'claude --resume abc-123',
    );
    expect(resumeCommand({ id: 'abc-123', projectPath: null })).toBe(
      'claude --resume abc-123',
    );
  });
});

describe('resumeScore', () => {
  it('is 0 for archived sessions regardless of other signals', () => {
    const s = {
      archived: true,
      columnId: 'col-todo',
      contextPct: 90,
      lastActivity: ago(0),
      lastDoneActivity: ago(DAY),
    };
    expect(resumeScore(s, { doneColumnId: DONE, nowMs })).toBe(0);
  });

  it('is 0 when the session is in the done column', () => {
    const s = {
      archived: false,
      columnId: DONE,
      contextPct: 90,
      lastActivity: ago(0),
    };
    expect(resumeScore(s, { doneColumnId: DONE, nowMs })).toBe(0);
  });

  it('sums contextPct + recency boost + reactivated bonus', () => {
    // contextPct 40, lastActivity within 1d (+30), reactivated (+25) = 95.
    const s = {
      archived: false,
      columnId: 'col-prog',
      contextPct: 40,
      lastActivity: ago(0),
      lastDoneActivity: ago(DAY),
    };
    expect(resumeScore(s, { doneColumnId: DONE, nowMs })).toBe(40 + 30 + 25);
  });

  it('applies the recency boost bands (30 / 20 / 10 / 0)', () => {
    const base = { archived: false, columnId: 'col-prog', contextPct: 0 };
    expect(
      resumeScore({ ...base, lastActivity: ago(0.5 * DAY) }, { doneColumnId: DONE, nowMs }),
    ).toBe(30);
    expect(
      resumeScore({ ...base, lastActivity: ago(2 * DAY) }, { doneColumnId: DONE, nowMs }),
    ).toBe(20);
    expect(
      resumeScore({ ...base, lastActivity: ago(5 * DAY) }, { doneColumnId: DONE, nowMs }),
    ).toBe(10);
    expect(
      resumeScore({ ...base, lastActivity: ago(30 * DAY) }, { doneColumnId: DONE, nowMs }),
    ).toBe(0);
  });

  it('treats a missing contextPct as 0', () => {
    const s = { archived: false, columnId: 'col-prog', lastActivity: ago(10 * DAY) };
    expect(resumeScore(s, { doneColumnId: DONE, nowMs })).toBe(0);
  });
});

describe('isWorthResuming', () => {
  it('is false when archived', () => {
    const s = { archived: true, columnId: 'col-prog', contextPct: 90, lastActivity: ago(0) };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(false);
  });

  it('is false when in the done column', () => {
    const s = { archived: false, columnId: DONE, contextPct: 90, lastActivity: ago(0) };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(false);
  });

  it('is true when context usage is at least 50%', () => {
    const s = { archived: false, columnId: 'col-prog', contextPct: 50, lastActivity: ago(30 * DAY) };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(true);
  });

  it('is true when reactivated even with low context and old activity', () => {
    const s = {
      archived: false,
      columnId: 'col-prog',
      contextPct: 5,
      lastActivity: ago(20 * DAY),
      lastDoneActivity: ago(40 * DAY),
    };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(true);
  });

  it('is true when last activity is within 2 days', () => {
    const s = { archived: false, columnId: 'col-prog', contextPct: 5, lastActivity: ago(1 * DAY) };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(true);
  });

  it('is false when low context, not reactivated and older than 2 days', () => {
    const s = { archived: false, columnId: 'col-prog', contextPct: 10, lastActivity: ago(3 * DAY) };
    expect(isWorthResuming(s, { doneColumnId: DONE, nowMs })).toBe(false);
  });
});

describe('sessionComparator', () => {
  const sort = (list, key) => [...list].sort(sessionComparator(key)).map((s) => s.id);

  it('board: orders by order asc then lastActivity desc', () => {
    const list = [
      { id: 'a', order: 1, lastActivity: ago(0) },
      { id: 'b', order: 0, lastActivity: ago(2 * DAY) },
      { id: 'c', order: 0, lastActivity: ago(0) }, // same order as b, more recent → first
    ];
    expect(sort(list, 'board')).toEqual(['c', 'b', 'a']);
  });

  it("board is the default for an unknown key", () => {
    const list = [
      { id: 'a', order: 2, lastActivity: ago(0) },
      { id: 'b', order: 1, lastActivity: ago(0) },
    ];
    expect(sort(list, 'mystery')).toEqual(['b', 'a']);
  });

  it('activity: most recent lastActivity first', () => {
    const list = [
      { id: 'a', lastActivity: ago(3 * DAY) },
      { id: 'b', lastActivity: ago(0) },
      { id: 'c', lastActivity: ago(1 * DAY) },
    ];
    expect(sort(list, 'activity')).toEqual(['b', 'c', 'a']);
  });

  it('context: highest contextPct first, null/undefined last', () => {
    const list = [
      { id: 'a', contextPct: 20 },
      { id: 'b', contextPct: null },
      { id: 'c', contextPct: 80 },
      { id: 'd' }, // undefined
    ];
    const out = sort(list, 'context');
    expect(out.slice(0, 2)).toEqual(['c', 'a']);
    // The two nullish ones land at the end (relative order among them is stable-ish).
    expect(out.slice(2).sort()).toEqual(['b', 'd']);
  });

  it('messages: highest messageCount first', () => {
    const list = [
      { id: 'a', messageCount: 3 },
      { id: 'b', messageCount: 10 },
      { id: 'c' }, // treated as 0
    ];
    expect(sort(list, 'messages')).toEqual(['b', 'a', 'c']);
  });

  it('created: newest createdAt first', () => {
    const list = [
      { id: 'a', createdAt: ago(5 * DAY) },
      { id: 'b', createdAt: ago(1 * DAY) },
      { id: 'c', createdAt: ago(10 * DAY) },
    ];
    expect(sort(list, 'created')).toEqual(['b', 'a', 'c']);
  });
});
