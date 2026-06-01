// scanner.test.js (node --test). Verifies isSessionFile: a real session is a
// depth-1 <uuid>.jsonl directly inside a project dir, and nested / non-uuid /
// non-.jsonl files are excluded (so workflow journals & subagent transcripts
// never appear as sessions or collide as ids).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { CLAUDE_PROJECTS_DIR } from '../src/config.js';
import { isSessionFile, SESSION_ID_RE } from '../src/scanner.js';

const UUID = '6ef97485-ce29-44ed-920e-92bbf2234791';
const project = path.join(CLAUDE_PROJECTS_DIR, '-Users-x-Desktop-proj');

test('isSessionFile: a depth-1 <uuid>.jsonl inside a project dir IS a session', () => {
  assert.equal(isSessionFile(path.join(project, `${UUID}.jsonl`)), true);
});

test('isSessionFile: a nested journal.jsonl is NOT a session', () => {
  const nested = path.join(project, UUID, 'subagents', 'workflows', 'wf', 'journal.jsonl');
  assert.equal(isSessionFile(nested), false);
});

test('isSessionFile: a <uuid>.jsonl nested deeper than depth 1 is NOT a session', () => {
  assert.equal(isSessionFile(path.join(project, UUID, `${UUID}.jsonl`)), false);
});

test('isSessionFile: a non-uuid basename is NOT a session', () => {
  assert.equal(isSessionFile(path.join(project, 'journal.jsonl')), false);
  assert.equal(isSessionFile(path.join(project, 'summary.jsonl')), false);
});

test('isSessionFile: a non-.jsonl file is NOT a session', () => {
  assert.equal(isSessionFile(path.join(project, `${UUID}.txt`)), false);
});

test('isSessionFile: a file sitting directly in the projects root is NOT a session', () => {
  assert.equal(isSessionFile(path.join(CLAUDE_PROJECTS_DIR, `${UUID}.jsonl`)), false);
});

test('SESSION_ID_RE matches uuids and rejects words', () => {
  assert.ok(SESSION_ID_RE.test(UUID));
  assert.ok(!SESSION_ID_RE.test('journal'));
});
