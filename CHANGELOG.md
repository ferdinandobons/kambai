# Changelog

All notable changes to Kambai are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-02

First release — a read-only, localhost Kanban board for Claude Code sessions.

### Features

- **Live board** over every session in `~/.claude/projects` (Server-Sent Events;
  new sessions appear and existing ones refresh in real time).
- **Customizable columns** (defaults: To do / In progress / Done) with
  drag-and-drop and a column editor.
- **Context-usage %** per card, **filters** (project / model / date / title
  search) and **sort** (last activity / context % / messages / created).
- **"Worth resuming" triage** (context + recency + reactivation score) surfaced
  as a quick filter with a count badge, plus quick-filter chips and
  **"reactivated"** detection.
- **Card details modal** with **title rename** (stored as an overlay override —
  session files are never modified, with reset-to-original) and a one-click
  **"copy resume command"** (`cd <path> && claude --resume <id>`) to the clipboard.
- **Archive** (hide) vs **Delete permanently** (UUID-guarded, path-contained).
- **Deep links** (`?session=<id>` opens a card on load).

### Engineering

- **Backend:** Node + Fastify (ESM), atomic JSON store with corrupt-store
  recovery, `chokidar` watcher, SSE.
- **Frontend:** React + Vite + dnd-kit, with optimistic updates that reconcile
  against the server and roll back on failure.
- **Read-only by design:** the only write under `~/.claude/projects` is the
  explicit Delete action.
- **190 tests** (75 backend `node --test`, 115 web `vitest` including a jsdom +
  Testing Library DOM harness) and **CI** on every push.

[1.0.0]: https://github.com/ferdinandobons/kambai/releases/tag/v1.0.0
