# Kambai

A **read-only**, localhost Kanban monitor for your [Claude Code](https://claude.com/claude-code) sessions.

Kambai scans every session stored under `~/.claude/projects/` and lays them out on a
Kanban board. You drag cards between columns to track which conversations are **done**
and which are **still to carry forward**. Each card shows the session title, project and
git branch, a colored **context-usage bar**, last activity, message count and model, and a
"riattivata" badge when a closed session sees new activity.

It updates **live**: the backend watches the session files and pushes changes to the UI
over Server-Sent Events.

> **Read-only by design.** Kambai never starts, resumes, or edits your sessions. It only
> reads files under `~/.claude/projects/`. The single exception is the explicit
> *Elimina definitivamente* (permanent delete) action, which removes one `.jsonl` file
> after a confirmation modal. The Kanban state itself lives in a separate local file
> (`data/store.json`), never inside `~/.claude/projects/`.

## Stack

- **Backend:** Node + Fastify (ESM), `chokidar` file watcher, SSE, JSON store.
- **Frontend:** React + Vite + dnd-kit.

## Install

From the repository root:

```bash
npm install
```

This installs the root tooling and both the `server/` and `web/` workspaces
(`npm run install:all` does the same explicitly).

## Run

```bash
npm run dev
```

This starts the backend on **http://localhost:4319** and the Vite dev server on
**http://localhost:5319** (which proxies `/api` and `/events` to the backend).

Open **http://localhost:5319** in your browser.

To override the backend port, set `KAMBAI_PORT`.

## Build (production)

```bash
npm run build      # builds web/dist
npm start          # backend serves web/dist as static
```

## Test

```bash
npm test           # runs server (node --test) and web (vitest) suites
```

## Project layout

```
kambai/
  package.json            # root scripts: dev (concurrently), install:all, test
  server/                 # Fastify backend (parser, scanner, store, watcher, sse, routes)
  web/                    # React + Vite + dnd-kit frontend
  data/                   # store.json (Kanban state, gitignored)
  docs/                   # design spec
```

See `docs/superpowers/specs/2026-06-01-kambai-design.md` for the full design.
