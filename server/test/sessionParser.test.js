// sessionParser.test.js (node --test). Fixture .jsonl -> SessionMeta.
// Verifies title (aiTitle + fallback), contextPct (calc + 1M window),
// messageCount, null-context handling, decodeProjectDir-derived fields, and
// tolerance to malformed / truncated last lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSessionFile } from '../src/sessionParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures');

const fixture = (...parts) => path.join(FIXTURES, ...parts);

// --- normal-session.jsonl: aiTitle, default 200k window, multi-message ---------

test('parseSessionFile: title comes from aiTitle when present', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  assert.equal(meta.title, 'Refactor auth middleware and add tests');
});

test('parseSessionFile: id is the filename UUID without extension', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  assert.equal(meta.id, 'normal-session');
});

test('parseSessionFile: contextPct with default 200k window', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  // Last assistant usage: 2040 + 41200 + 1800 = 45040.
  assert.equal(meta.contextTokens, 45040);
  assert.equal(meta.contextWindow, 200000);
  // round(45040 / 200000 * 100) = round(22.52) = 23.
  assert.equal(meta.contextPct, 23);
});

test('parseSessionFile: uses the LAST assistant usage, not the first', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  // First assistant usage summed to 29420; the last one must win.
  assert.notEqual(meta.contextTokens, 29420);
  assert.equal(meta.contextTokens, 45040);
});

test('parseSessionFile: messageCount counts user + assistant lines', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  // 2 user + 2 assistant; ai-title and last-prompt lines do not count.
  assert.equal(meta.messageCount, 4);
});

test('parseSessionFile: extracts lastPrompt, gitBranch, model, timestamps', async () => {
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  assert.equal(meta.lastPrompt, 'Great, now add unit tests for the helper.');
  assert.equal(meta.gitBranch, 'feature/auth');
  assert.equal(meta.model, 'claude-opus-4-7');
  assert.equal(meta.createdAt, '2026-05-30T09:12:04.512Z');
  assert.equal(meta.lastActivity, '2026-05-30T09:15:31.701Z');
});

test('parseSessionFile: sizeBytes matches the file size on disk', async () => {
  const stat = await fs.stat(fixture('normal-session.jsonl'));
  const meta = await parseSessionFile(fixture('normal-session.jsonl'));
  assert.equal(meta.sizeBytes, stat.size);
});

// --- edge-session.jsonl: no aiTitle, 1M window, truncated last line ------------

test('parseSessionFile: title falls back to first user prompt snippet', async () => {
  const meta = await parseSessionFile(fixture('edge-session.jsonl'));
  assert.equal(meta.title, 'Scaffold the Kambai project and write the config module first.');
});

test('parseSessionFile: contextPct with 1M window (model id contains [1m])', async () => {
  const meta = await parseSessionFile(fixture('edge-session.jsonl'));
  assert.equal(meta.model, 'claude-opus-4-8[1m]');
  // Only valid assistant usage (line 2): 5200 + 180000 + 12000 = 197200.
  assert.equal(meta.contextTokens, 197200);
  assert.equal(meta.contextWindow, 1000000);
  // round(197200 / 1000000 * 100) = round(19.72) = 20.
  assert.equal(meta.contextPct, 20);
});

test('parseSessionFile: skips malformed / truncated last line', async () => {
  const meta = await parseSessionFile(fixture('edge-session.jsonl'));
  // The truncated final assistant line is skipped, so it is not counted and
  // its (partial) usage/model does not override the last valid one.
  // 2 user + 1 valid assistant = 3.
  assert.equal(meta.messageCount, 3);
  assert.equal(meta.contextTokens, 197200);
});

test('parseSessionFile: last-prompt line populates lastPrompt over user text', async () => {
  const meta = await parseSessionFile(fixture('edge-session.jsonl'));
  assert.equal(meta.lastPrompt, 'Now add the watcher with chokidar.');
  assert.equal(meta.gitBranch, 'main');
});

// --- encoded-project fixture: decodeProjectDir-derived fields ------------------

test('parseSessionFile: derives projectDir/Path/Name from the parent dir', async () => {
  const meta = await parseSessionFile(
    fixture('-Users-ferdinandobons-Desktop-DS4-ds4', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jsonl'),
  );
  assert.equal(meta.id, 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e');
  assert.equal(meta.projectDir, '-Users-ferdinandobons-Desktop-DS4-ds4');
  assert.equal(meta.projectPath, '/Users/ferdinandobons/Desktop/DS4/ds4');
  assert.equal(meta.projectName, 'ds4');
});

test('parseSessionFile: handles string-form message content and 50% window', async () => {
  const meta = await parseSessionFile(
    fixture('-Users-ferdinandobons-Desktop-DS4-ds4', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jsonl'),
  );
  // 1000 + 98000 + 1000 = 100000 over a 200k window = exactly 50%.
  assert.equal(meta.contextTokens, 100000);
  assert.equal(meta.contextWindow, 200000);
  assert.equal(meta.contextPct, 50);
  assert.equal(meta.title, 'Wire up the SSE hub');
  assert.equal(meta.messageCount, 2);
});

// --- minimal-no-usage.jsonl: null context, no title, mtime fallback -----------

test('parseSessionFile: null context fields when no usage data is present', async () => {
  const meta = await parseSessionFile(fixture('minimal-no-usage.jsonl'));
  assert.equal(meta.contextTokens, null);
  assert.equal(meta.contextWindow, null);
  assert.equal(meta.contextPct, null);
  assert.equal(meta.model, null);
});

test('parseSessionFile: title is "(senza titolo)" with no aiTitle and no user text', async () => {
  const meta = await parseSessionFile(fixture('minimal-no-usage.jsonl'));
  assert.equal(meta.title, '(senza titolo)');
});

test('parseSessionFile: missing fields fall back (lastPrompt/gitBranch/createdAt null)', async () => {
  const meta = await parseSessionFile(fixture('minimal-no-usage.jsonl'));
  assert.equal(meta.lastPrompt, null);
  assert.equal(meta.gitBranch, null);
  assert.equal(meta.createdAt, null);
  // One assistant line, no user lines.
  assert.equal(meta.messageCount, 1);
});

test('parseSessionFile: lastActivity falls back to file mtime when no timestamps', async () => {
  const stat = await fs.stat(fixture('minimal-no-usage.jsonl'));
  const meta = await parseSessionFile(fixture('minimal-no-usage.jsonl'));
  assert.equal(meta.lastActivity, stat.mtime.toISOString());
  // It is still a valid ISO string.
  assert.equal(meta.lastActivity, new Date(meta.lastActivity).toISOString());
});

// --- inline temp fixture: fully truncated file is tolerated -------------------

test('parseSessionFile: tolerates a file whose only line is truncated JSON', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kambai-'));
  const file = path.join(tmpDir, 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80.jsonl');
  // A single, never-terminated JSON line (mid-write live session).
  await fs.writeFile(file, '{"type":"assistant","message":{"role":"assistant","mod', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    assert.equal(meta.messageCount, 0);
    assert.equal(meta.contextTokens, null);
    assert.equal(meta.title, '(senza titolo)');
    assert.equal(meta.id, 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- fallback title skips slash-command / caveat envelopes --------------------

test('parseSessionFile: fallback title skips command/caveat envelopes', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kambai-'));
  const file = path.join(tmpDir, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl');
  // First user line is a local-command caveat wrapper; the real prompt follows.
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these.</local-command-caveat>' },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Fix the failing pagination query in the dashboard.' },
    }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    // Title is the real prompt, NOT the caveat boilerplate.
    assert.equal(meta.title, 'Fix the failing pagination query in the dashboard.');
    // Both user lines still counted.
    assert.equal(meta.messageCount, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
