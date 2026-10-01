/**
 * Server-sent events about a user's documents (`GET /api/documents/tree-events`), scoped per user.
 *
 * - `tree-changed` — the page tree changed: a document created, moved, renamed, trashed…
 * - `content-changed` — a document's content was stored (REST sync or the live relay), with the ids.
 *   What lets a desktop that stays online pull another device's edits to pages it does not have open
 *   (SYNC.md): the relay only reaches pages a client has open. Throttled per user, since the relay
 *   stores roughly every keystroke batch; clients that do not listen for it ignore it.
 */
import type { Response } from 'express';

/** SSE streams keyed by userId. */
const sseClients = new Map<string, Set<Response>>();

/** At most one `content-changed` per user in this window; the ids of the rest ride on it. */
export const CONTENT_EVENT_THROTTLE_MS = 2_000;

export function addDocumentEventClient(userId: string, res: Response): () => void {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId)!.add(res);
  return () => {
    const set = sseClients.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseClients.delete(userId);
  };
}

function send(userId: string, event: string, data: string): void {
  const clients = sseClients.get(userId);
  if (!clients) return;
  for (const client of clients) {
    try {
      client.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      // Socket already closed; the 'close' handler will clean it up.
    }
  }
}

/** Broadcast a tree-changed event to every SSE client belonging to `userId`. */
export function broadcastTreeChanged(userId: string): void {
  send(userId, 'tree-changed', '{}');
}

/** Per user: the ids waiting to be announced, and whether an announcement is scheduled. */
const pendingContent = new Map<string, { ids: Set<string>; timer: ReturnType<typeof setTimeout> | null; last: number }>();

/**
 * Announce that `documentId`'s content was stored. The first change in a quiet period goes out at
 * once; later ones within `CONTENT_EVENT_THROTTLE_MS` are gathered into one event at its end.
 */
export function broadcastContentChanged(userId: string, documentId: string): void {
  let pending = pendingContent.get(userId);
  if (!pending) {
    pending = { ids: new Set(), timer: null, last: 0 };
    pendingContent.set(userId, pending);
  }
  pending.ids.add(documentId);
  if (pending.timer) return;
  const flush = () => {
    const entry = pendingContent.get(userId)!;
    entry.timer = null;
    if (entry.ids.size === 0) return;
    send(userId, 'content-changed', JSON.stringify({ ids: [...entry.ids] }));
    entry.ids.clear();
    entry.last = Date.now();
  };
  const wait = pending.last + CONTENT_EVENT_THROTTLE_MS - Date.now();
  if (wait <= 0) flush();
  else pending.timer = setTimeout(flush, wait);
}
