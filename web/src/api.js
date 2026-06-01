// api.js — thin fetch wrappers around the REST API plus an SSE subscribe()
// helper built on EventSource. All URLs are relative so the Vite dev proxy
// (/api and /events → backend) and the production static server both work.

/**
 * Internal helper: perform a fetch, throw on non-2xx, parse JSON when present.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
async function request(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && (body.error || body.message) ? `: ${body.error || body.message}` : '';
    } catch {
      // non-JSON error body; ignore
    }
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}${detail}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

/** POST/PATCH/DELETE helper with a JSON body. */
function send(method, url, body) {
  return request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * GET /api/sessions
 * @returns {Promise<{ sessions: object[], columns: object[] }>}
 */
export async function getSessions() {
  return request('/api/sessions');
}

/**
 * GET /api/board
 * @returns {Promise<object>} Store
 */
export async function getBoard() {
  return request('/api/board');
}

/**
 * POST /api/cards/:id/move
 * @param {string} id
 * @param {string} columnId
 * @param {number} order
 * @returns {Promise<object>}
 */
export async function moveCard(id, columnId, order) {
  return send('POST', `/api/cards/${encodeURIComponent(id)}/move`, { columnId, order });
}

/**
 * POST /api/cards/:id/archive
 * @param {string} id
 * @param {boolean} archived
 * @returns {Promise<object>}
 */
export async function archiveCard(id, archived) {
  return send('POST', `/api/cards/${encodeURIComponent(id)}/archive`, { archived });
}

/**
 * DELETE /api/sessions/:id — permanently deletes the .jsonl from disk.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function deleteSession(id) {
  return send('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
}

/**
 * PATCH /api/cards/:id/title — set a custom title override.
 * An empty string resets the card back to its original parsed title.
 * @param {string} id
 * @param {string} title
 * @returns {Promise<object>} The updated store (board).
 */
export async function setTitle(id, title) {
  return send('PATCH', `/api/cards/${encodeURIComponent(id)}/title`, { title });
}

/**
 * POST /api/columns
 * @param {string} name
 * @returns {Promise<object>} The created column.
 */
export async function addColumn(name) {
  return send('POST', '/api/columns', { name });
}

/**
 * PATCH /api/columns/:id
 * @param {string} id
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function renameColumn(id, name) {
  return send('PATCH', `/api/columns/${encodeURIComponent(id)}`, { name });
}

/**
 * POST /api/columns/reorder
 * @param {string[]} ids
 * @returns {Promise<object>}
 */
export async function reorderColumns(ids) {
  return send('POST', '/api/columns/reorder', { ids });
}

/**
 * DELETE /api/columns/:id
 * @param {string} id
 * @param {string} moveCardsTo - column id to move existing cards to.
 * @returns {Promise<object>}
 */
export async function deleteColumn(id, moveCardsTo) {
  return send('DELETE', `/api/columns/${encodeURIComponent(id)}`, { moveCardsTo });
}

/**
 * Subscribe to the SSE stream at /events.
 * Each server-sent message is a JSON-encoded event object; this parses it and
 * forwards it to onEvent. Malformed frames are ignored.
 *
 * @param {(event: object) => void} onEvent - Called with each parsed event.
 * @returns {() => void} Unsubscribe function that closes the EventSource.
 */
export function subscribe(onEvent) {
  const es = new EventSource('/events');

  es.onmessage = (e) => {
    if (!e || !e.data) return;
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return; // skip malformed frame
    }
    onEvent(parsed);
  };

  // EventSource auto-reconnects on transient errors; nothing to do here beyond
  // letting it retry. We intentionally do not close on error.
  es.onerror = () => {};

  return () => es.close();
}
