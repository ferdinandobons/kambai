// sessionParser.test.js (node --test). Fixture .jsonl -> SessionMeta.
// Verifies title (aiTitle + fallback), contextPct (calc + 1M window),
// messageCount, null-context handling, decodeProjectDir-derived fields, and
// tolerance to malformed / truncated last lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSessionFile, parseSessionPrompts } from '../src/sessionParser.js';

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
  assert.equal(meta.title, 'Scaffold the Kanbai project and write the config module first.');
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

test('parseSessionFile: title is "(untitled)" with no aiTitle and no user text', async () => {
  const meta = await parseSessionFile(fixture('minimal-no-usage.jsonl'));
  assert.equal(meta.title, '(untitled)');
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
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
  const file = path.join(tmpDir, 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80.jsonl');
  // A single, never-terminated JSON line (mid-write live session).
  await fs.writeFile(file, '{"type":"assistant","message":{"role":"assistant","mod', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    assert.equal(meta.messageCount, 0);
    assert.equal(meta.contextTokens, null);
    assert.equal(meta.title, '(untitled)');
    assert.equal(meta.id, 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- fallback title skips slash-command / caveat envelopes --------------------

test('parseSessionFile: fallback title skips command/caveat envelopes', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
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

test('parseSessionFile: fallback title skips a JSON-payload first message', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
  const file = path.join(tmpDir, 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d61.jsonl');
  // First user line is a programmatic JSON payload; the real prompt follows.
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '{ "project_dir": "/Users/x/Desktop/proj", "mode": "observe" }' },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Add dark mode to the settings page.' },
    }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    assert.equal(meta.title, 'Add dark mode to the settings page.');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- automated flag: no ai-title + JSON-payload first message -----------------

/** Write a one-or-more-line .jsonl temp session and parse it. */
async function parseInline(lines) {
  const tmpDir = await fs.mkdtemp(path.join(await fs.realpath((await import('node:os')).tmpdir()), 'kanbai-'));
  const file = path.join(tmpDir, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl');
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  try {
    return await parseSessionFile(file);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('parseSessionFile: automated=true when no ai-title and the first user msg is a JSON payload', async () => {
  const meta = await parseInline([
    { type: 'user', message: { role: 'user', content: '{ "project_dir": "/x", "transcript_path": "/y/bonsai-inline/z" }' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
  ]);
  assert.equal(meta.automated, true);
  assert.equal(meta.title, '(untitled)');
});

test('parseSessionFile: automated=false when the session has an ai-title (even with a JSON opener)', async () => {
  const meta = await parseInline([
    { type: 'ai-title', aiTitle: 'Run the gardener' },
    { type: 'user', message: { role: 'user', content: '{ "project_dir": "/x" }' } },
  ]);
  assert.equal(meta.automated, false);
  assert.equal(meta.title, 'Run the gardener');
});

test('parseSessionFile: automated=false for a normal human prompt with no ai-title', async () => {
  const meta = await parseInline([
    { type: 'user', message: { role: 'user', content: 'Refactor the auth module.' } },
  ]);
  assert.equal(meta.automated, false);
});

test('parseSessionFile: automated=false for a slash-command (non-JSON) opener', async () => {
  const meta = await parseInline([
    { type: 'user', message: { role: 'user', content: '<command-name>/bonsai:status</command-name>' } },
  ]);
  assert.equal(meta.automated, false);
});

// --- a trailing <synthetic> assistant turn must NOT zero contextTokens --------

test('parseSessionFile: a final <synthetic> assistant turn does not zero out context', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
  const file = path.join(tmpDir, 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f.jsonl');
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 5000, cache_read_input_tokens: 180000, cache_creation_input_tokens: 12000 },
      },
    }),
    // Interrupted/aborted turn: a synthetic assistant line carrying an all-zero
    // usage object. This is the LAST assistant line; it must be ignored.
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    // contextTokens reflects the LAST real assistant usage, not the synthetic 0.
    // 5000 + 180000 + 12000 = 197000.
    assert.equal(meta.contextTokens, 197000);
    // model is the real model, not "<synthetic>".
    assert.equal(meta.model, 'claude-opus-4-8');
    assert.ok(meta.contextPct > 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- tool_result-only user lines must NOT inflate messageCount ----------------

test('parseSessionFile: tool_result-only user lines are not counted as messages', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
  const file = path.join(tmpDir, 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70.jsonl');
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Run the build and fix any errors.' },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    }),
    // Tool-result envelope: NOT a human turn, must not count.
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Great, now run the tests.' },
    }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    // 2 real user turns + 1 assistant; the tool_result-only user line is skipped.
    assert.equal(meta.messageCount, 3);
    // The fallback title is the first real prompt, not the tool result.
    assert.equal(meta.title, 'Run the build and fix any errors.');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- the authoritative entry.cwd is preferred over the lossy decodeProjectDir --

test('parseSessionFile: prefers the recorded cwd over the dash-mangled dir name', async () => {
  const tmpDir = await fs.mkdtemp(path.join((await fs.realpath((await import('node:os')).tmpdir())), 'kanbai-'));
  // Encoded dir name mangles the worktree dotfile + hyphenated leaf when decoded.
  const projDir = path.join(tmpDir, '-Users-x-Desktop-Proj--claude-worktrees-nervous-herschel-1aada5');
  await fs.mkdir(projDir, { recursive: true });
  const file = path.join(projDir, 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081.jsonl');
  const realCwd = '/Users/x/Desktop/Proj/.claude/worktrees/nervous-herschel-1aada5';
  const lines = [
    JSON.stringify({ type: 'user', cwd: realCwd, message: { role: 'user', content: 'Start work.' } }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const meta = await parseSessionFile(file);
    assert.equal(meta.projectPath, realCwd);
    assert.equal(meta.projectName, 'nervous-herschel-1aada5');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('parseSessionFile: falls back to decodeProjectDir when no line carries a cwd', async () => {
  const meta = await parseSessionFile(
    fixture('-Users-ferdinandobons-Desktop-DS4-ds4', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jsonl'),
  );
  // No cwd on the fixture lines → the decoded dir name is still used.
  assert.equal(meta.projectPath, '/Users/ferdinandobons/Desktop/DS4/ds4');
  assert.equal(meta.projectName, 'ds4');
});

// --- parseSessionPrompts: the human prompt history --------------------------

test('parseSessionPrompts: returns human turns in order, skipping tool_result/JSON/command', async () => {
  const tmpDir = await fs.mkdtemp(path.join(await fs.realpath((await import('node:os')).tmpdir()), 'kanbai-'));
  const file = path.join(tmpDir, 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d62.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-06-01T10:00:00.000Z', message: { role: 'user', content: '{ "project_dir": "/x" }' } }, // JSON payload -> skip
    { type: 'user', timestamp: '2026-06-01T10:01:00.000Z', message: { role: 'user', content: 'Add cursor pagination' } },
    { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } }, // tool result -> skip
    { type: 'user', timestamp: '2026-06-01T10:05:00.000Z', message: { role: 'user', content: 'Now add unit tests' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/bonsai:status</command-name>' } }, // command -> skip
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  try {
    const { prompts, total } = await parseSessionPrompts(file);
    assert.equal(total, 2);
    assert.deepEqual(prompts.map((p) => p.text), ['Add cursor pagination', 'Now add unit tests']);
    assert.equal(prompts[0].ts, '2026-06-01T10:01:00.000Z');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
