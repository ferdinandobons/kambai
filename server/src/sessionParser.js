// sessionParser.js — Parse a single Claude Code session .jsonl file into a
// SessionMeta object. Reads ONLY inside CLAUDE_PROJECTS_DIR (callers pass paths
// discovered by the scanner). Malformed / truncated lines (e.g. the last line
// of a live session) are tolerated and skipped.
//
// SECURITY: this module does NOT itself validate filePath. It is only ever
// called with paths the scanner enumerated from inside CLAUDE_PROJECTS_DIR, or
// the DELETE route's resolveSessionFile output, which re-verifies containment
// (realpath + isInside) before handing the path over. Containment is therefore
// enforced UPSTREAM; do not call parseSessionFile with an unvalidated path.

import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectDir, getContextWindow } from './config.js';

/**
 * @typedef {Object} SessionMeta
 * @property {string} id            - Session UUID (file basename without extension).
 * @property {string} projectDir    - Encoded project directory name.
 * @property {string} projectPath   - Best-effort decoded project path.
 * @property {string} projectName   - Human-friendly project name (last path segment).
 * @property {string} title         - aiTitle || snippet of first user prompt || "(untitled)".
 * @property {string|null} lastPrompt
 * @property {string|null} gitBranch
 * @property {string|null} model
 * @property {number|null} contextTokens   - input + cache_read + cache_creation of last assistant usage.
 * @property {number|null} contextWindow   - From getContextWindow(model).
 * @property {number|null} contextPct       - round(contextTokens / contextWindow * 100).
 * @property {number} messageCount          - Count of user + assistant lines.
 * @property {string|null} createdAt        - ISO of first timestamp.
 * @property {string} lastActivity          - ISO of last timestamp, fallback file mtime.
 * @property {number} sizeBytes
 * @property {boolean} automated            - No ai-title AND a JSON-payload first user message
 *                                            (a programmatic/agent session; hidden by default in the UI).
 */

const NO_TITLE = '(untitled)';
const SNIPPET_MAX = 120;

/**
 * Extract the plain text from a message `content` field, which may be a string
 * or an array of content blocks ({ type: 'text', text: '...' }).
 *
 * @param {unknown} content
 * @returns {string|null}
 */
function extractText(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const joined = parts.join('').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * True for a "user" line that is a tool-result envelope rather than a real human
 * turn. In real Claude Code sessions the large majority of `user` lines carry
 * `message.content` = [{ type: 'tool_result', ... }] — the round-trip output of a
 * tool the assistant invoked, not a typed prompt. Counting these inflates
 * messageCount well beyond the human-visible conversation length it implies.
 *
 * Judged purely structurally: content must be a non-empty array whose every
 * block is `type: 'tool_result'`. A string or text-bearing content is a real
 * message and returns false.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (block) => block && typeof block === 'object' && block.type === 'tool_result',
  );
}

/**
 * True when `text` is a whole JSON object/array — i.e. a programmatic payload
 * (an agent/hook-launched session whose first "user" message is a JSON blob like
 * `{ "project_dir": …, "transcript_path": … }`), not a human prompt.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isJsonPayload(text) {
  const t = text.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    // Not valid JSON (or truncated) → ordinary prose.
    return false;
  }
}

/**
 * True for "user" messages that are command/system envelopes rather than a real
 * prompt: slash-command wrappers, local-command caveats, bash io blocks,
 * prompt-submit hooks, or a whole-JSON payload. The fallback title skips these so
 * a session that opened with a slash command (or a JSON blob) does not get titled
 * "<local-command-caveat>Caveat: …" or "{ "project_dir": … }".
 *
 * @param {string} text
 * @returns {boolean}
 */
function isMetaText(text) {
  const t = text.trimStart();
  if (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<bash-') ||
    t.startsWith('<user-prompt-submit-hook') ||
    t.startsWith('Caveat: The messages below were generated')
  ) {
    return true;
  }
  return isJsonPayload(text);
}

/**
 * Collapse whitespace and clamp a string to a short snippet for display.
 *
 * @param {string} text
 * @returns {string}
 */
function snippet(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

/**
 * Parse a single session .jsonl file into a SessionMeta.
 *
 * @param {string} filePath - Absolute path to the .jsonl file.
 * @returns {Promise<SessionMeta>}
 */
export async function parseSessionFile(filePath) {
  const stat = await fs.stat(filePath);
  const sizeBytes = stat.size;

  // id = file basename without the .jsonl extension (the session UUID).
  const id = path.basename(filePath, '.jsonl');
  // projectDir = the encoded directory name that contains the file.
  const projectDir = path.basename(path.dirname(filePath));

  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    raw = '';
  }

  let aiTitle = null;
  let firstUserText = null;
  // The very first human-typed user message (before the meta/JSON skip), used to
  // flag programmatic/"automated" sessions (no ai-title + a JSON-payload opener).
  let firstUserRaw = null;
  let lastPrompt = null;
  let gitBranch = null;
  let model = null;
  // The authoritative cwd, present verbatim on user/assistant lines as
  // `entry.cwd`. decodeProjectDir mangles paths with real dashes or dotfiles
  // (worktrees, hyphenated names), so prefer the recorded cwd when available.
  let cwd = null;
  /** @type {number|null} */
  let contextTokens = null;
  let messageCount = 0;
  let createdAt = null;
  let lastTimestamp = null;

  const lines = raw.split('\n');
  for (const line of lines) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      // Malformed / truncated line (e.g. the live session's last line). Skip it.
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const type = entry.type;

    // Track first/last timestamps across every line that carries one.
    if (typeof entry.timestamp === 'string' && entry.timestamp.length > 0) {
      if (createdAt === null) {
        createdAt = entry.timestamp;
      }
      lastTimestamp = entry.timestamp;
    }

    // gitBranch may appear on many line types; keep the LAST non-empty one in
    // file order. The .jsonl is append-only and chronological (timestamps only
    // advance as we scan), so the last in file order is also the most recent
    // value — i.e. the branch the session is currently on.
    if (typeof entry.gitBranch === 'string' && entry.gitBranch.length > 0) {
      gitBranch = entry.gitBranch;
    }

    // cwd may appear on many line types and can vary per line (e.g. a sub-line
    // in a nested dir). Keep the FIRST non-empty one — the session root.
    if (cwd === null && typeof entry.cwd === 'string' && entry.cwd.length > 0) {
      cwd = entry.cwd;
    }

    if (type === 'ai-title') {
      if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim().length > 0) {
        aiTitle = entry.aiTitle.trim();
      }
      continue;
    }

    if (type === 'last-prompt') {
      if (typeof entry.lastPrompt === 'string' && entry.lastPrompt.trim().length > 0) {
        lastPrompt = entry.lastPrompt.trim();
      }
      continue;
    }

    if (type === 'user') {
      const content = entry.message && entry.message.content;
      // Skip tool-result envelopes: the vast majority of `user` lines in a real
      // session are [{type:'tool_result', ...}] round-trips, not human turns.
      // Counting them inflates messageCount far beyond the conversation length
      // the field implies, and they never carry a usable fallback title.
      if (isToolResultOnly(content)) {
        continue;
      }
      messageCount += 1;
      const userText = extractText(content);
      if (firstUserRaw === null && userText) {
        firstUserRaw = userText;
      }
      if (firstUserText === null) {
        // Use the first REAL user prompt for the fallback title, skipping
        // command/caveat envelopes (a slash-command session otherwise titles
        // itself with boilerplate).
        if (userText && !isMetaText(userText)) {
          firstUserText = userText;
        }
      }
      continue;
    }

    if (type === 'assistant') {
      messageCount += 1;
      const message = entry.message;
      if (message && typeof message === 'object') {
        // Claude Code emits `<synthetic>` assistant lines for interrupted /
        // aborted turns and API-error placeholders. They carry a usage object
        // with all-zero token fields and a "<synthetic>" model id. Ignore them
        // entirely so a trailing synthetic turn does not zero out contextTokens
        // (the headline context metric) or clobber the real model/context window.
        if (message.model === '<synthetic>') {
          continue;
        }
        if (typeof message.model === 'string' && message.model.length > 0) {
          model = message.model;
        }
        const usage = message.usage;
        if (usage && typeof usage === 'object') {
          const input = Number(usage.input_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
          // Use the LAST assistant usage seen; overwrite on each occurrence.
          // (Synthetic, usage-less turns are already skipped above.)
          contextTokens = input + cacheRead + cacheCreation;
        }
      }
      continue;
    }
  }

  // Prefer the authoritative cwd recorded on the session lines for the displayed
  // path/name; fall back to the lossy decodeProjectDir only when no line carried
  // a cwd. This makes worktree and hyphenated-name projects display correctly.
  const projectPath = cwd ?? decodeProjectDir(projectDir);
  const segments = projectPath.split('/').filter(Boolean);
  const projectName = segments.length > 0 ? segments[segments.length - 1] : projectDir;

  // Context window + percentage. Null when token data is missing.
  let contextWindow = null;
  let contextPct = null;
  if (contextTokens !== null) {
    contextWindow = getContextWindow(model);
    // Some sessions ran on a larger window than the model id advertised (e.g. a
    // 1M-context beta whose model string lacks an explicit [1m] tag). If the
    // measured tokens exceed the model default, bump to the 1M tier so the
    // percentage stays meaningful instead of reading e.g. 377%.
    if (contextTokens > contextWindow) {
      contextWindow = Math.max(contextWindow, 1_000_000);
    }
    contextPct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
  }

  // Title precedence: aiTitle -> snippet of first user prompt -> "(untitled)".
  let title = NO_TITLE;
  if (aiTitle) {
    title = aiTitle;
  } else if (firstUserText) {
    title = snippet(firstUserText);
  }

  // "Automated" = a programmatic session, not a human conversation: no
  // AI-generated title AND its first user message is a whole JSON payload (the
  // signature of agent/hook-launched runs, e.g. Bonsai observers). The UI hides
  // these by default behind a one-click toggle so they don't flood the board.
  const automated = !aiTitle && firstUserRaw !== null && isJsonPayload(firstUserRaw);

  // lastActivity: last timestamp seen, falling back to the file mtime.
  const lastActivity = lastTimestamp !== null ? lastTimestamp : stat.mtime.toISOString();

  return {
    id,
    projectDir,
    projectPath,
    projectName,
    title,
    lastPrompt,
    gitBranch,
    model,
    contextTokens,
    contextWindow,
    contextPct,
    messageCount,
    createdAt,
    lastActivity,
    sizeBytes,
    automated,
  };
}
