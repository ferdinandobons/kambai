# Kambai — Kanban monitor per sessioni di Claude Code

Data: 2026-06-01
Stato: approvato, in implementazione

## Obiettivo

Un'app **localhost in sola lettura** che monitora tutte le sessioni di Claude Code
presenti in `~/.claude/projects/` e le organizza in una board Kanban. L'utente sposta
le card tra colonne per tracciare quali conversazioni sono **finite** e quali sono
**da portare avanti**. Le sessioni contengono tutto il contesto/ragionamenti, quindi
sono preziose: l'app le visualizza e le tiene in ordine, NON le avvia né le riprende.

## Decisioni di prodotto (dal brainstorming)

- **Natura:** solo monitoraggio. Niente launch/resume di sessioni.
- **Colonne:** default *Da fare / In corso / Fatto*, ma completamente personalizzabili
  dalla UI (aggiungi/rinomina/riordina/elimina).
- **Scope:** carica TUTTE le sessioni di tutti i progetti, con filtri (progetto, data,
  modello, ricerca testo) e raggruppamento. Possibilità di nascondere/archiviare ed
  eliminare definitivamente.
- **Card:** mostra il **% di contesto usato** e altre info utili (vedi sotto).
- **Eliminazione:** due azioni distinte — *Archivia/Nascondi* (toglie dalla board, file
  intatto, reversibile) e *Elimina definitivamente* (cancella il `.jsonl` da disco, con
  conferma, irreversibile).
- **Aggiornamento:** live automatico (il backend osserva i file e fa push via SSE).
- **Stack:** Node + Fastify (backend), React + Vite + dnd-kit (frontend), SSE per il
  live, store JSON locale per lo stato Kanban.

## Fuori scope (YAGNI)

Niente auth (localhost mono-utente), niente accesso remoto, niente avvio/resume sessioni,
niente database (un file JSON basta). SQLite eventualmente in futuro.

## Fonte dati (sola lettura)

Ogni sessione è un file `~/.claude/projects/<dir-progetto-codificata>/<uuid>.jsonl`.
Il nome cartella è il `cwd` con i `/` sostituiti da `-` (es. `-Users-ferdinandobons-Desktop-DS4-ds4`).
Ogni riga del `.jsonl` è un evento JSON. Righe rilevanti:

- `{"type":"ai-title","aiTitle": "...", "sessionId": "..."}` → titolo riconoscibile.
- `{"type":"last-prompt","lastPrompt":"...", ...}` → ultimo prompt utente.
- righe `assistant` con `message.usage` → token: `input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`.
- righe `assistant` con `message.model` → modello (es. `claude-opus-4-7`).
- campi `cwd`, `gitBranch`, `timestamp` presenti su molte righe.
- conteggio messaggi = righe con `type` `user` o `assistant`.

L'ultima riga può essere incompleta se la sessione è viva: il parser DEVE tollerare
righe JSON malformate saltandole e continuando.

### Calcolo % contesto

`contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
dell'**ultimo** messaggio assistant con `usage`. `contextWindow` dal modello
(default 200000; 1000000 se il model id contiene `1m`/`[1m]`). `contextPct = round(contextTokens / contextWindow * 100)`.
Se mancano dati → `null` (in UI mostra "—").

## Architettura

```
~/.claude/projects/*/*.jsonl   ← fonte (sola lettura, tranne DELETE)
        │ chokidar watch
   Backend (Node + Fastify, ESM)
     - sessionParser / scanner : .jsonl → SessionMeta
     - store                   : data/store.json (stato Kanban)
     - watcher + sse           : push live
     - routes (REST + SSE)
        │ HTTP /api + SSE /events
   Frontend (React + Vite + dnd-kit)
     - Board / Column / Card / FilterBar / ColumnEditor / ConfirmModal
```

Il backend non scrive MAI dentro `~/.claude/projects` tranne l'endpoint DELETE.

## Layout repository

```
kambai/
  package.json            # root: script dev (concurrently), install workspace
  .gitignore
  README.md
  docs/superpowers/specs/2026-06-01-kambai-design.md
  data/                   # store.json (gitignorato)
  server/
    package.json          # "type":"module"
    src/
      index.js            # Fastify app: registra routes, static, avvia watcher, listen
      config.js           # COMPLETO già allo scaffold: percorsi, finestre contesto, helper
      sessionParser.js    # parseSessionFile()
      scanner.js          # scanAllSessions(), listSessionFiles()
      store.js            # load/save store.json, overlay + colonne CRUD (atomico)
      watcher.js          # chokidar → callback su add/change/unlink (debounce)
      sse.js              # hub SSE: addClient(reply), broadcast(event)
      routes.js           # tutti gli endpoint REST + GET /events
    test/
      sessionParser.test.js
      store.test.js
      fixtures/*.jsonl
  web/
    package.json          # react, vite, @dnd-kit/*, vitest
    vite.config.js        # proxy /api e /events → http://localhost:4319
    index.html
    src/
      main.jsx
      App.jsx
      api.js              # fetch wrappers + subscribe(EventSource)
      util.js             # timeAgo(), contextColor(pct) — funzioni pure testabili
      components/{Board,Column,Card,FilterBar,ColumnEditor,ConfirmModal}.jsx
      styles.css
    test/util.test.js
```

Porte: backend **4319**, Vite dev **5319** (proxy verso 4319). In produzione il
backend serve `web/dist` come statico.

## Contratto di interfacce (gli implementatori lo rispettano alla lettera)

### config.js (scritto COMPLETO allo scaffold, gli altri lo importano)
```
export const CLAUDE_PROJECTS_DIR  // path.join(os.homedir(), '.claude', 'projects')
export const STORE_PATH           // <repo>/data/store.json
export const PORT                 // 4319 (override da env KAMBAI_PORT)
export function getContextWindow(model) // number, default 200000, 1_000_000 se /1m/i
export function decodeProjectDir(name)  // "-Users-x-y" → "/Users/x/y" (best effort)
```

### SessionMeta (output del parser)
```
{
  id, projectDir, projectPath, projectName,
  title,                 // aiTitle || snippet primo prompt utente || "(senza titolo)"
  lastPrompt|null, gitBranch|null, model|null,
  contextTokens|null, contextWindow|null, contextPct|null,
  messageCount,          // user + assistant
  createdAt|null,        // ISO del primo timestamp
  lastActivity,          // ISO ultimo timestamp, fallback mtime file
  sizeBytes
}
```
- `sessionParser.js`: `export async function parseSessionFile(filePath) -> SessionMeta`
- `scanner.js`: `export async function listSessionFiles() -> string[]`,
  `export async function scanAllSessions() -> SessionMeta[]`

### store.js — store.json
```
{
  version: 1,
  columns: [ { id, name, color, order } ],   // default: Da fare/In corso/Fatto
  overlay: { [sessionId]: { columnId, order, archived, lastDoneActivity|null } }
}
```
Export:
```
loadStore() -> Store
getBoard() -> Store                      // copia sicura
moveCard(sessionId, columnId, order)
setArchived(sessionId, archived)
removeOverlay(sessionId)
ensurePlaced(sessionId, isDoneColumnFn?) // se non presente → prima colonna
addColumn(name) -> column
renameColumn(id, name)
reorderColumns(idsInOrder)
deleteColumn(id, moveCardsToColumnId)    // sposta le card prima di eliminare
```
Scrittura atomica: scrivi su file temporaneo poi `rename`. Store corrotto → backup
`.bak` e riparti dai default.

### REST API (prefix /api) + SSE
```
GET    /api/sessions            -> { sessions: SessionMeta[] (merge con overlay: columnId, order, archived), columns }
GET    /api/board               -> Store
POST   /api/cards/:id/move      { columnId, order }
POST   /api/cards/:id/archive   { archived: boolean }
DELETE /api/sessions/:id        -> elimina il .jsonl da disco (vedi sicurezza)
POST   /api/columns             { name } -> column
PATCH  /api/columns/:id         { name }
POST   /api/columns/reorder     { ids: [] }
DELETE /api/columns/:id         { moveCardsTo }
GET    /events                  -> SSE; eventi:
        { type: "session.added"|"session.updated", session: SessionMeta }
        { type: "session.removed", id }
        { type: "store.changed", store } // dopo azioni che cambiano overlay/colonne
```

### Sicurezza (critico per DELETE e per la lettura file)

- `DELETE /api/sessions/:id`: `:id` DEVE matchare un UUID v4 (regex). Il file da
  cancellare va **risolto** e verificato che `path.resolve(file)` sia contenuto in
  `CLAUDE_PROJECTS_DIR` (no path traversal, no symlink escape). Mai cancellare nulla
  fuori da quella cartella. 404 se non trovato.
- Il parser/scanner legge SOLO dentro `CLAUDE_PROJECTS_DIR`.
- Nessuna esecuzione di comandi a partire da input dell'utente.

### Comportamenti

- **Live:** watcher su `*.jsonl` (add/change/unlink), con debounce (~300ms). add →
  parse → `session.added`; change → parse → `session.updated`; unlink →
  `session.removed`. Nuova sessione → `ensurePlaced` nella prima colonna.
- **Badge "riattivata":** quando una card viene spostata in una colonna considerata
  "done" (l'ultima colonna, o una flag), si salva `lastDoneActivity = lastActivity`.
  Se poi arriva nuova attività (`lastActivity > lastDoneActivity`), la card mostra un
  badge "riattivata". Per v1: "done" = l'ultima colonna per `order`.
- **Filtri (frontend):** per progetto, range data (es. ultimi N giorni), modello,
  ricerca testo sul titolo; toggle "mostra archiviate".
- **Archivia:** `archived=true` → nascosta dalla board (visibile col toggle).
- **Elimina definitivamente:** modale di conferma → DELETE → rimuove overlay → card via.
- **Editor colonne:** eliminare una colonna con card chiede `moveCardsTo`.

## Card (UI)

Titolo · `projectName` + `gitBranch` (piccolo) · **barra % contesto** colorata
(verde <50, ambra 50–80, rosso >80) · ultima attività relativa ("2h fa") · n° messaggi
+ modello · badge "riattivata" se applicabile · snippet `lastPrompt` in hover/expand ·
menù azioni (Archivia, Elimina).

## Gestione errori

Righe `.jsonl` malformate / ultima riga incompleta → saltate. Campi mancanti →
fallback. File rimosso durante il watch → `session.removed`. Errore scrittura store →
write atomica; store corrotto → backup e default. Cartella progetti con permessi
`drwx------` (solo owner) → ok, giriamo come l'utente.

## Testing

- **server/test/sessionParser.test.js** (`node --test`): fixture `.jsonl` →
  verifica `title` (aiTitle e fallback), `contextPct` (calcolo + finestra 1M),
  `messageCount`, tolleranza a righe malformate / ultima riga troncata.
- **server/test/store.test.js** (`node --test`): move, archive, removeOverlay,
  ensurePlaced, CRUD colonne (incl. deleteColumn con spostamento card), scrittura
  atomica e recupero da store corrotto. Usa una STORE_PATH temporanea.
- **web/test/util.test.js** (`vitest`): `timeAgo()`, `contextColor()`.
- Verifica build: `npm install` ok, `node --test` verde, `vitest` verde,
  `npm run build` del frontend ok, `npm run dev` avvia entrambi.

## Avvio

`npm install` (root, installa server e web) → `npm run dev` avvia backend (4319) +
Vite (5319). Apri `http://localhost:5319`.
