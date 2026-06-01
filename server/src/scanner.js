// scanner.js — Discover session files and produce SessionMeta for all of them.
// Reads ONLY inside CLAUDE_PROJECTS_DIR. Resilient: a single failing file must
// not abort the whole batch.

import fs from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { parseSessionFile } from './sessionParser.js';

/** @typedef {import('./sessionParser.js').SessionMeta} SessionMeta */

/**
 * Recursively collect every *.jsonl file path under a directory. Symlinked
 * directories are not followed (withFileTypes reports the link itself), keeping
 * traversal inside CLAUDE_PROJECTS_DIR. Unreadable subdirectories are skipped.
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {string[]} out - Accumulator for matching file paths.
 * @returns {Promise<void>}
 */
async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory missing or unreadable (e.g. permissions) → skip silently.
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/**
 * List all session .jsonl file paths under CLAUDE_PROJECTS_DIR.
 *
 * @returns {Promise<string[]>} Absolute paths to every *.jsonl session file.
 */
export async function listSessionFiles() {
  const files = [];
  await walk(CLAUDE_PROJECTS_DIR, files);
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
