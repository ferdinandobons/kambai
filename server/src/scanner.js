// scanner.js — Discover session files and produce SessionMeta for all of them.
// Reads ONLY inside CLAUDE_PROJECTS_DIR. Resilient: a single failing file must
// not abort the whole batch.

import fs from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { parseSessionFile } from './sessionParser.js';

/** @typedef {import('./sessionParser.js').SessionMeta} SessionMeta */

/**
 * Loose UUID matcher (8-4-4-4-12 hex) for session filenames. A session file is
 * always named `<uuid>.jsonl`, which lets us exclude non-session files such as
 * workflow journals or summaries that share the .jsonl extension.
 */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is `filePath` a real Claude Code session file? A session is a `<uuid>.jsonl`
 * sitting DIRECTLY inside a project directory, i.e. exactly one level under
 * CLAUDE_PROJECTS_DIR (`<projects>/<projectDir>/<uuid>.jsonl`).
 *
 * This deliberately excludes everything nested deeper — subagent transcripts and
 * workflow journals live under `<projects>/<projectDir>/<uuid>/.../*.jsonl` and
 * often share basenames (e.g. many `journal.jsonl`), which are NOT user sessions
 * and would collide as ids.
 *
 * @param {string} filePath - Absolute path.
 * @returns {boolean}
 */
export function isSessionFile(filePath) {
  if (!filePath.endsWith('.jsonl')) return false;
  const base = path.basename(filePath, '.jsonl');
  if (!SESSION_ID_RE.test(base)) return false;
  // The file's directory (the project dir) must be a direct child of the
  // projects root.
  const projectDir = path.dirname(path.resolve(filePath));
  return path.dirname(projectDir) === path.resolve(CLAUDE_PROJECTS_DIR);
}

/**
 * List all session .jsonl file paths under CLAUDE_PROJECTS_DIR. Scans exactly two
 * levels — the project directories and the `<uuid>.jsonl` files directly inside
 * them — so nested subagent/workflow files are never treated as sessions.
 * Unreadable directories are skipped silently; symlinked project dirs are not
 * followed (Dirent.isDirectory() is false for a symlink).
 *
 * @returns {Promise<string[]>} Absolute paths to every session file.
 */
export async function listSessionFiles() {
  const files = [];

  let projectDirs;
  try {
    projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    // Projects root missing or unreadable → no sessions.
    return files;
  }

  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectPath = path.join(CLAUDE_PROJECTS_DIR, pd.name);

    let entries;
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(id)) continue;
      files.push(path.join(projectPath, entry.name));
    }
  }

  files.sort();
  return files;
}

/**
 * Scan and parse every session under CLAUDE_PROJECTS_DIR. A file that fails to
 * parse is logged and omitted rather than aborting the entire scan.
 *
 * @returns {Promise<SessionMeta[]>}
 */
export async function scanAllSessions() {
  const files = await listSessionFiles();
  const results = await Promise.allSettled(files.map((file) => parseSessionFile(file)));

  const sessions = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      sessions.push(result.value);
    } else {
      // Resilient: one bad file must not abort the batch.
      console.error(`[scanner] failed to parse ${files[i]}:`, result.reason);
    }
  }
  return sessions;
}
