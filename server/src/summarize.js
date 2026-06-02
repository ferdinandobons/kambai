// summarize.js — generate a 1-2 sentence summary of a session via the local
// `claude` CLI (reusing the user's existing Claude Code auth — no API key).
//
// NOT read-only: this is the one action that sends a session's prompts to the
// model. It is gated behind an explicit user click ("Summarize") and the result
// is cached in the overlay so it runs once per session.
//
// `claude -p` logs a throwaway session under its cwd inside ~/.claude/projects,
// which would otherwise pollute the board (and get summarized itself). We run it
// in a unique temp cwd and delete exactly that one project dir afterwards.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_PROJECTS_DIR } from './config.js';

const exec = promisify(execFile);

/** Cheap model by default; overridable for testing/tuning. */
const SUMMARY_MODEL = process.env.KANBAI_SUMMARY_MODEL || 'haiku';
const MAX_OUTLINE = 60;

/**
 * Summarize a session from its human prompt history using `claude -p`.
 *
 * @param {Array<{ text: string }>} prompts - the session's human turns (parseSessionPrompts).
 * @returns {Promise<string>} a short summary; throws if the CLI is missing/fails.
 */
export async function summarizeSession(prompts) {
  const outline = (prompts || [])
    .slice(0, MAX_OUTLINE)
    .map((p, i) => `${i + 1}. ${p.text}`)
    .join('\n');
  const instruction =
    'Summarize this Claude Code session for a Kanban card in 1-2 plain, factual ' +
    'sentences: what it was about and where it left off. Output only the summary, ' +
    `no preamble.\n\nThe user's prompts, in order:\n${outline || '(no prompts)'}`;

  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kanbai-sum-'));
  try {
    const { stdout } = await exec('claude', ['-p', '--model', SUMMARY_MODEL, instruction], {
      cwd: tmpCwd,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    // Delete the throwaway session `claude -p` logged for this call. The temp cwd
    // is unique, so its encoded project dir (~/.claude/projects/-<encoded-path>)
    // is unique too — only this one dir is removed, never a real session.
    try {
      const real = await fs.realpath(tmpCwd);
      const encoded = real.replace(/\//g, '-');
      await fs.rm(path.join(CLAUDE_PROJECTS_DIR, encoded), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    await fs.rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
  }
}
