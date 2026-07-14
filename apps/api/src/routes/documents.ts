import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import type {
  Document,
  DocumentType,
  CreateDocumentPayload,
  UpdateDocumentPayload,
  RepositionDocumentPayload,
  StructOp,
  SyncStructuralPayload,
  SyncStructuralResult,
} from '@ubimate/types';
import { generateKeyBetween } from '@ubimate/utils';
import { requireAuth } from '../middleware/auth';
import { registryStmts, resolvePrimaryWorkspaceId } from '../db/registry';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');

export const documentsRouter = Router();

// All document routes require authentication.
documentsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// SSE — tree-change notifications (scoped per user)
// ---------------------------------------------------------------------------

/** SSE streams keyed by userId. */
const sseClients = new Map<string, Set<Response>>();

/**
 * Broadcast a tree-changed event to every SSE client belonging to `userId`.
 */
export function broadcastTreeChanged(userId: string): void {
  const clients = sseClients.get(userId);
  if (!clients) return;
  for (const client of clients) {
    try {
      client.write('event: tree-changed\ndata: {}\n\n');
    } catch {
      // Socket already closed; the 'close' handler will clean it up.
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal shape as stored in SQLite — properties is a raw JSON string. */
interface DocumentRow {
  id: string;
  parent_id: string | null;
  type: DocumentType;
  position: string;
  properties: string; // JSON string — parsed by toOut()
  created_at: number;
  updated_at: number;
  /** Unix ms of the last structural operation applied to this document. Used for LWW sync. */
  last_struct_ts: number;
  /** Unix ms of the last properties update. Independent LWW domain from last_struct_ts. */
  last_properties_ts: number;
  status: number;
  status_timestamp: number | null;
  yjs_sv_hash: string | null;
}

function toOut(row: DocumentRow): Document {
  return {
    id: row.id,
    parent_id: row.parent_id,
    type: row.type,
    position: row.position,
    properties: JSON.parse(row.properties),
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status ?? 0,
    status_timestamp: row.status_timestamp ?? null,
    yjs_sv_hash: row.yjs_sv_hash ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/documents
// Returns ALL documents (tree data — client builds the hierarchy).
// ---------------------------------------------------------------------------
documentsRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await _req.userDbHandle.storage.listDocuments();
  res.json(rows.map(toOut));
});

// ---------------------------------------------------------------------------
// GET /api/documents/tree-events
// Server-Sent Events stream: emits a "tree-changed" event whenever the
// document tree is mutated.
// ---------------------------------------------------------------------------
documentsRouter.get('/tree-events', (req: Request, res: Response) => {
  // Disable the server-side socket timeout — SSE connections are intentionally
  // long-lived and must not be killed by the default Node.js socket timeout.
  req.socket?.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Initial comment forces the first TCP chunk out immediately so the browser
  // confirms the stream is alive and doesn't report ERR_INCOMPLETE_CHUNKED_ENCODING.
  res.write(': connected\n\n');

  const userId = req.userId;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId)!.add(res);

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* socket gone */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(userId);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id
// ---------------------------------------------------------------------------
documentsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = await req.userDbHandle.storage.getDocument(req.params.id);
  if (!row) return res.status(404).json({ error: 'Document not found' });
  res.json(toOut(row));
});

// ---------------------------------------------------------------------------
// POST /api/documents
// Body: { parent_id?, type, position?, properties? }
// ---------------------------------------------------------------------------
documentsRouter.post('/', (req: Request, res: Response) => {
  const { stmts } = req.userDbHandle;
  const { parent_id = null, type, properties = {} } = req.body as CreateDocumentPayload;
  const { wrappedWorkspaceKey } = req.body as { wrappedWorkspaceKey?: string };

  // Derive position: place after the last sibling, or use the client-supplied value if present.
  const lastRow = stmts.lastSiblingPosition.get(parent_id) as { position: string } | undefined;
  const position = (req.body as CreateDocumentPayload).position
    ?? generateKeyBetween(lastRow?.position ?? null, null);

  if (!type || !['page', 'db-page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry'].includes(type)) {
    return res.status(400).json({ error: 'Invalid or missing `type`' });
  }

  const now = Date.now();
  const doc = {
    id: randomUUID(),
    parent_id,
    type,
    position,
    properties: JSON.stringify(properties),
    created_at: now,
    updated_at: now,
    last_struct_ts: now,
    last_properties_ts: now,
    status: 0,
    status_timestamp: null,
    yjs_sv_hash: null,
  };

  stmts.insertDocument.run(doc);

  // When a new workspace is created, persist the user's sealed copy of its content key.
  if (type === 'workspace' && wrappedWorkspaceKey && typeof wrappedWorkspaceKey === 'string') {
    registryStmts.insertWorkspaceKey.run({
      workspace_id: doc.id,
      user_id: req.userId,
      wrapped_key: wrappedWorkspaceKey,
      granted_at: now,
    });
  }

  broadcastTreeChanged(req.userId);
  res.status(201).json(toOut({ ...doc }));
});

// ---------------------------------------------------------------------------
// PUT /api/documents/:id
// Body: { parent_id?, type?, position?, properties? }
// Partial update — only provided fields are changed.
// ---------------------------------------------------------------------------
documentsRouter.put('/:id', (req: Request, res: Response) => {
  const { stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const { parent_id, type, position, properties } = req.body as UpdateDocumentPayload;

  const updated = {
    id: existing.id,
    parent_id:          parent_id  !== undefined ? parent_id  : existing.parent_id,
    type:               type        !== undefined ? type        : existing.type,
    position:           position    !== undefined ? position    : existing.position,
    properties:         properties  !== undefined
      ? JSON.stringify(properties)
      : existing.properties,
    updated_at:         Date.now(),
    last_struct_ts:     existing.last_struct_ts,
    last_properties_ts: properties !== undefined ? Date.now() : existing.last_properties_ts,
    status: existing.status,
    status_timestamp: existing.status_timestamp,
    yjs_sv_hash: existing.yjs_sv_hash,
  };

  stmts.updateDocument.run(updated);

  // Clean up the superseded upload file when `src` changes on a media document.
  // The file is immutable (UUID-named), so it can be deleted as soon as the
  // reference is replaced.  Only applies to server-hosted uploads (/uploads/…).
  if (properties !== undefined && (updated.type === 'image' || updated.type === 'file')) {
    try {
      const oldProps = JSON.parse(existing.properties) as Record<string, unknown>;
      const oldSrc = typeof oldProps.src === 'string' ? oldProps.src : null;
      const newSrc = typeof (properties as Record<string, unknown>).src === 'string'
        ? (properties as Record<string, unknown>).src as string
        : null;
      if (oldSrc && oldSrc !== newSrc && oldSrc.startsWith('/uploads/')) {
        const filename = path.basename(oldSrc);
        if (filename && !filename.includes('..')) {
          const filePath = path.join(DATA_DIR, 'uploads', req.userId, filename);
          fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') {
              console.error(`[uploads] Failed to delete replaced file ${filePath}:`, err.message);
            }
          });
        }
      }
    } catch {
      // Malformed JSON — skip silently.
    }
  }

  broadcastTreeChanged(req.userId);
  res.json(toOut({ ...updated, created_at: existing.created_at }));
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/reposition
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/reposition', (req: Request, res: Response) => {
  const { stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const { parent_id = null, before_id = null, client_ts } = req.body as RepositionDocumentPayload;

  if (client_ts !== undefined && client_ts <= existing.last_struct_ts) {
    return res.json(toOut(existing));
  }

  let position: string;

  if (before_id === null) {
    const lastRow = stmts.lastSiblingPosition.get(parent_id) as { position: string } | undefined;
    const lastPos = lastRow && lastRow.position !== existing.position ? lastRow.position : null;
    position = generateKeyBetween(lastPos, null);
  } else {
    const beforeDoc = stmts.getDocument.get(before_id) as DocumentRow | undefined;
    if (!beforeDoc) return res.status(404).json({ error: 'before_id document not found' });

    const prevRow = stmts.siblingPositionBefore.get({
      parent_id,
      before_pos: beforeDoc.position,
      exclude_id: existing.id,
    }) as { position: string } | undefined;

    position = generateKeyBetween(prevRow?.position ?? null, beforeDoc.position);
  }

  const updated = {
    id: existing.id,
    parent_id,
    type: existing.type,
    position,
    properties: existing.properties,
    updated_at: Date.now(),
    last_struct_ts: client_ts ?? Date.now(),
    last_properties_ts: existing.last_properties_ts,
    status: existing.status,
    status_timestamp: existing.status_timestamp,
    yjs_sv_hash: existing.yjs_sv_hash,
  };

  stmts.repositionDocument.run(updated);
  broadcastTreeChanged(req.userId);
  res.json(toOut({ ...updated, created_at: existing.created_at }));
});

// ---------------------------------------------------------------------------
// POST /api/sync/structural
// Body: { ops: StructOp[] }
//
// Replays a batch of structural operations recorded by an offline local app.
// Ops are sorted by client_ts (ascending) so older decisions are applied first
// and the most-recent intent for each document ends up winning (LWW).
// All ops run inside a single SQLite transaction for atomicity.
//
// Returns the full canonical document list after the batch so the caller can
// overwrite its local state with the authoritative server state.
// ---------------------------------------------------------------------------
documentsRouter.post('/sync/structural', (req: Request, res: Response) => {
  const { db, stmts } = req.userDbHandle;
  const { ops } = req.body as SyncStructuralPayload;

  if (!Array.isArray(ops)) {
    return res.status(400).json({ error: '`ops` must be an array' });
  }

  // The protected home workspace can never be deleted — skip any delete op that
  // targets it (e.g. a stale offline tombstone replayed from another device).
  const primaryWorkspaceId = resolvePrimaryWorkspaceId(req.userId);

  // Sort ascending so older decisions are applied first; newer ones overwrite.
  // For 'create' ops we additionally ensure parents precede children by doing a
  // topological sort: build a map of id→parent_id from create ops, then order
  // them so every parent is emitted before its children.  Non-create ops keep
  // their timestamp order and run after all creates.
  const createOps = ops.filter(o => o.op === 'create');
  const otherOps  = ops.filter(o => o.op !== 'create').sort((a, b) => a.client_ts - b.client_ts);

  // Topological sort of create ops (Kahn's algorithm).
  const createMap = new Map(createOps.map(o => [o.id, o]));
  const childrenOf = new Map<string | null, string[]>();
  for (const o of createOps) {
    const pid = (o.payload as { parent_id?: string | null }).parent_id ?? null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(o.id);
  }
  const sortedCreates: typeof createOps = [];
  // Roots are creates whose parent is not itself being created in this batch.
  const queue = createOps
    .filter(o => {
      const pid = (o.payload as { parent_id?: string | null }).parent_id ?? null;
      return pid === null || !createMap.has(pid);
    })
    .sort((a, b) => a.client_ts - b.client_ts);
  while (queue.length) {
    const cur = queue.shift()!;
    sortedCreates.push(cur);
    for (const childId of (childrenOf.get(cur.id) ?? []).sort()) {
      queue.push(createMap.get(childId)!);
    }
  }
  // Any remaining (cycles or orphaned) fall back to timestamp order.
  const emitted = new Set(sortedCreates.map(o => o.id));
  for (const o of createOps.filter(o => !emitted.has(o.id)).sort((a, b) => a.client_ts - b.client_ts)) {
    sortedCreates.push(o);
  }

  const sorted = [...sortedCreates, ...otherOps];

  let applied = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const op of sorted) {
      const existing = stmts.getDocument.get(op.id) as DocumentRow | undefined;

      if (op.op === 'create') {
        // ------------------------------------------------------------------
        // Idempotent insert: skip entirely if the document already exists.
        // (A create can arrive twice if the client retries after a network
        //  blip; the second copy is harmless to discard.)
        // ------------------------------------------------------------------
        if (existing) { skipped++; continue; }

        const payload = op.payload as CreateDocumentPayload & { status?: number; status_timestamp?: number | null };
        if (!payload.type || !['page', 'db-page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry'].includes(payload.type)) {
          skipped++; continue;
        }
        const lastRow = stmts.lastSiblingPosition.get(payload.parent_id ?? null) as
          { position: string } | undefined;
        const position = payload.position ?? generateKeyBetween(lastRow?.position ?? null, null);

        stmts.insertDocument.run({
          id:            op.id,
          parent_id:     payload.parent_id ?? null,
          type:          payload.type,
          position,
          properties:    JSON.stringify(payload.properties ?? {}),
          created_at:    op.client_ts,
          updated_at:    op.client_ts,
          last_struct_ts:     op.client_ts,
          last_properties_ts: op.client_ts,
          status:        payload.status ?? 0,
          status_timestamp: payload.status_timestamp ?? null,
        });

        // When a new workspace is created via offline-sync replay, persist the
        // caller's sealed copy of its content key (key-per-workspace model) so
        // it can be recovered on re-login and shared with collaborators.
        // Use upsert so repeated syncs are idempotent (e.g., the op is replayed
        // after a reconnect or initial sync is re-run).
        if (payload.type === 'workspace' && payload.wrappedWorkspaceKey && typeof payload.wrappedWorkspaceKey === 'string') {
          registryStmts.upsertWorkspaceKey.run({
            workspace_id: op.id,
            user_id: req.userId,
            wrapped_key: payload.wrappedWorkspaceKey,
            granted_at: op.client_ts,
          });
        }
        applied++;
        continue;
      }

      if (op.op === 'delete') {
        // ------------------------------------------------------------------
        // LWW delete: only delete if this op is newer than the last structural
        // change recorded on the document (prevents a stale offline delete
        // from removing an item that was renamed/moved more recently).
        // ------------------------------------------------------------------
        if (!existing) { skipped++; continue; }
        // The home workspace is protected and can never be deleted.
        if (op.id === primaryWorkspaceId) { skipped++; continue; }
        if (op.client_ts <= existing.last_struct_ts) { skipped++; continue; }

        const deleteNow = Date.now();
        stmts.deleteDocument.run(op.id, deleteNow, deleteNow);
        stmts.deleteYjsUpdatesForSubtree.run(op.id);
        applied++;
        continue;
      }

      if (op.op === 'reposition') {
        if (!existing) { skipped++; continue; }
        if (op.client_ts <= existing.last_struct_ts) { skipped++; continue; }

        const { parent_id = null, before_id = null, position: directPosition } =
          op.payload as RepositionDocumentPayload;

        let position: string;
        // If the sync layer supplied the exact fractional-index position string,
        // use it directly (preserves ordering without needing a before_id lookup).
        if (directPosition) {
          position = directPosition;
        } else if (before_id === null) {
          const lastRow = stmts.lastSiblingPosition.get(parent_id) as
            { position: string } | undefined;
          const lastPos = lastRow && lastRow.position !== existing.position
            ? lastRow.position
            : null;
          position = generateKeyBetween(lastPos, null);
        } else {
          const beforeDoc = stmts.getDocument.get(before_id) as DocumentRow | undefined;
          if (!beforeDoc) { skipped++; continue; }
          const prevRow = stmts.siblingPositionBefore.get({
            parent_id,
            before_pos: beforeDoc.position,
            exclude_id: existing.id,
          }) as { position: string } | undefined;
          position = generateKeyBetween(prevRow?.position ?? null, beforeDoc.position);
        }

        stmts.repositionDocument.run({
          id:            existing.id,
          parent_id,
          position,
          updated_at:    op.client_ts,
          last_struct_ts: op.client_ts,
        });
        applied++;
        continue;
      }

      if (op.op === 'update_properties') {
        if (!existing) { skipped++; continue; }
        // LWW: compare against last_properties_ts (independent of last_struct_ts
        // so that a reposition on one device doesn't silently drop a rename from
        // another device that arrived with a slightly older timestamp).
        if (op.client_ts <= (existing.last_properties_ts ?? 0)) { skipped++; continue; }

        const payload = op.payload as UpdateDocumentPayload;
        stmts.syncUpdateProperties.run({
          id:                 op.id,
          properties:         JSON.stringify(payload.properties ?? JSON.parse(existing.properties)),
          updated_at:         op.client_ts,
          last_properties_ts: op.client_ts,
        });
        applied++;
        continue;
      }

      if (op.op === 'update_status') {
        if (!existing) { skipped++; continue; }
        // LWW: compare against status_timestamp (not last_struct_ts, which tracks
        // structural changes like reposition/rename that are orthogonal to status).
        if (op.client_ts <= (existing.status_timestamp ?? 0)) { skipped++; continue; }

        const payload = op.payload as { status: number };
        stmts.updateDocumentStatus.run({
          id:               op.id,
          status:           payload.status,
          status_timestamp: op.client_ts,
          updated_at:       op.client_ts,
        });
        applied++;
        continue;
      }

      // Unknown op kind — skip
      skipped++;
    }
  })();

  const allRows = stmts.listDocuments.all() as DocumentRow[];
  const result: SyncStructuralResult = {
    applied,
    skipped,
    documents: allRows.map(toOut),
  };
  if (applied > 0) broadcastTreeChanged(req.userId);
  res.json(result);
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/trash
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/trash', (req: Request, res: Response) => {
  const { db, stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  if (req.params.id === resolvePrimaryWorkspaceId(req.userId)) {
    return res.status(403).json({ error: 'The home workspace cannot be deleted.' });
  }
  const now = Date.now();
  db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM documents WHERE id = ?
      UNION ALL
      SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
    )
    UPDATE documents SET status = status | 2, status_timestamp = ?, updated_at = ?
    WHERE id IN (SELECT id FROM subtree)
  `).run(req.params.id, now, now);
  const updated = stmts.getDocument.get(req.params.id) as DocumentRow;
  broadcastTreeChanged(req.userId);
  res.json(toOut(updated));
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/untrash
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/untrash', (req: Request, res: Response) => {
  const { db, stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const now = Date.now();
  db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM documents WHERE id = ?
      UNION ALL
      SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
    )
    UPDATE documents SET status = (status & ~2), status_timestamp = ?, updated_at = ?
    WHERE id IN (SELECT id FROM subtree)
  `).run(req.params.id, now, now);
  const updated = stmts.getDocument.get(req.params.id) as DocumentRow;
  broadcastTreeChanged(req.userId);
  res.json(toOut(updated));
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/archive
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/archive', (req: Request, res: Response) => {
  const { stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const now = Date.now();
  stmts.archiveDocument.run(now, now, req.params.id);
  const updated = stmts.getDocument.get(req.params.id) as DocumentRow;
  broadcastTreeChanged(req.userId);
  res.json(toOut(updated));
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/unarchive
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/unarchive', (req: Request, res: Response) => {
  const { stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const now = Date.now();
  stmts.unarchiveDocument.run(now, now, req.params.id);
  const updated = stmts.getDocument.get(req.params.id) as DocumentRow;
  broadcastTreeChanged(req.userId);
  res.json(toOut(updated));
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id
// ---------------------------------------------------------------------------
documentsRouter.delete('/:id', (req: Request, res: Response) => {
  const { db, stmts } = req.userDbHandle;
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  if (req.params.id === resolvePrimaryWorkspaceId(req.userId)) {
    return res.status(403).json({ error: 'The home workspace cannot be deleted.' });
  }

  const userUploadsDir = path.join(DATA_DIR, 'uploads', req.userId);

  // Gather image/file-type descendants to clean up uploaded files.
  const subtree = (db.prepare(`
    WITH RECURSIVE subtree(id, type, properties) AS (
      SELECT id, type, properties FROM documents WHERE id = ?
      UNION ALL
      SELECT d.id, d.type, d.properties
      FROM documents d
      JOIN subtree s ON d.parent_id = s.id
    )
    SELECT type, properties FROM subtree WHERE type IN ('image', 'file')
  `).all(req.params.id) as Array<{ type: string; properties: string }>);

  for (const row of subtree) {
    try {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const src = typeof props.src === 'string' ? props.src : null;
      if (!src) continue;
      const filename = path.basename(new URL(src).pathname);
      if (!filename || filename.includes('..')) continue;
      const filePath = path.join(userUploadsDir, filename);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.error(`[uploads] Failed to delete ${filePath}:`, err.message);
        }
      });
    } catch {
      // Malformed URL or JSON — skip silently.
    }
  }

  // deleteDocument prepared statement soft-deletes the whole subtree (status = 4 tombstone).
  const permanentDeleteNow = Date.now();
  stmts.deleteDocument.run(req.params.id, permanentDeleteNow, permanentDeleteNow);
  stmts.deleteYjsUpdatesForSubtree.run(req.params.id);
  broadcastTreeChanged(req.userId);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id/yjs
// Returns the document's stored Yjs updates as an ordered list of opaque
// base64 blobs. These blobs are end-to-end encrypted (zero-knowledge): the
// server NEVER decodes them. The client decrypts each blob with the workspace
// content key and merges them locally. Used by the Tauri desktop client during
// initial / reconnect catch-up sync.
// ---------------------------------------------------------------------------
documentsRouter.get('/:id/yjs', async (req: Request, res: Response) => {
  const updates = await req.userDbHandle.storage.getYjsUpdates(req.params.id);
  // Opaque pass-through: emit the stored blobs verbatim, in order.
  const blobs = updates.map((u) => Buffer.from(u).toString('base64'));
  return res.json({ updates: blobs });
});

// ---------------------------------------------------------------------------
// POST /api/documents/:id/yjs
// Accepts a single opaque (encrypted) Yjs blob and stores it. The server never
// decodes the bytes, so it cannot merge updates or compute a state vector —
// compaction is client-driven via `replace`, and the state-vector hash is
// supplied by the client and stored verbatim.
//
// Body: { update: string; yjs_sv_hash?: string; replace?: boolean }
//   - update: base64-encoded opaque (encrypted) Yjs blob
//   - yjs_sv_hash: client-computed hash of the merged state (stored as-is)
//   - replace: when true, replace ALL stored blobs with this single snapshot
//              (client-driven compaction); otherwise append.
// ---------------------------------------------------------------------------
documentsRouter.post('/:id/yjs', async (req: Request, res: Response) => {
  const { update, yjs_sv_hash, replace } = req.body as {
    update?: string;
    yjs_sv_hash?: string;
    replace?: boolean;
  };
  if (typeof update !== 'string' || !update) {
    return res.status(400).json({ error: 'update (base64 string) is required' });
  }

  let updateBytes: Buffer;
  try {
    updateBytes = Buffer.from(update, 'base64');
  } catch {
    return res.status(400).json({ error: 'update must be a valid base64 string' });
  }

  const { storage } = req.userDbHandle;

  if (replace) {
    // Client-driven compaction: replace the stored blobs with one snapshot.
    await storage.compactYjsUpdates(req.params.id, updateBytes, yjs_sv_hash ?? null);
  } else {
    await storage.appendYjsUpdate(req.params.id, updateBytes);
    if (yjs_sv_hash) {
      await storage.updateYjsSvHash(req.params.id, yjs_sv_hash);
    }
  }

  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /api/documents/sync/yjs-check
// Batch endpoint: accepts an array of { id, yjs_sv_hash } pairs from the
// client and returns the ids of documents whose content differs from the
// client's. The hash is an opaque client-computed value compared verbatim —
// the server never decodes the encrypted blobs.
//
// Body: { docs: Array<{ id: string; yjs_sv_hash: string | null }> }
// Response: { changed: Array<{ id: string; yjs_sv_hash: string | null }> }
// ---------------------------------------------------------------------------
documentsRouter.post('/sync/yjs-check', async (req: Request, res: Response) => {
  const { docs } = req.body as { docs?: Array<{ id: string; yjs_sv_hash: string | null }> };
  if (!Array.isArray(docs)) {
    return res.status(400).json({ error: 'docs array is required' });
  }

  const { storage } = req.userDbHandle;
  const changed: Array<{ id: string; yjs_sv_hash: string | null }> = [];

  for (const { id, yjs_sv_hash: clientHash } of docs) {
    const row = await storage.getDocument(id);
    const serverHash = row?.yjs_sv_hash ?? null;

    // Both sides agree on the (opaque) hash — nothing to sync.
    if (clientHash && serverHash && clientHash === serverHash) continue;

    // No stored hash to compare against: fall back to "has any content?".
    // The server cannot compute a hash from ciphertext, so when either side
    // reports content we mark the document changed and let the client
    // reconcile (it holds the key and does the real merge).
    const serverHasContent = (await storage.countYjsUpdates(id)) > 0;
    if (!clientHash && !serverHasContent) continue;

    changed.push({ id, yjs_sv_hash: serverHash });
  }

  return res.json({ changed });
});

// ---------------------------------------------------------------------------
// POST /api/documents/sync/yjs-push
// Batch endpoint: accepts an array of opaque (encrypted) Yjs blobs and stores
// them in one HTTP round-trip. The server never decodes the bytes; compaction
// is client-driven via per-entry `replace`, and hashes are stored verbatim.
//
// Body: { updates: Array<{ id: string; update: string; yjs_sv_hash?: string; replace?: boolean }> }
//   - update: base64-encoded opaque (encrypted) Yjs blob
//   - yjs_sv_hash: client-computed hash of the merged state (stored as-is)
//   - replace: when true, replace ALL stored blobs for this id with the snapshot
// ---------------------------------------------------------------------------
documentsRouter.post('/sync/yjs-push', (req: Request, res: Response) => {
  const { updates } = req.body as {
    updates?: Array<{ id: string; update: string; yjs_sv_hash?: string; replace?: boolean }>;
  };
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'updates array is required' });
  }

  const { appendYjsUpdate, compactYjsUpdates } = req.userDbHandle;

  for (const { id, update, yjs_sv_hash, replace } of updates) {
    if (typeof update !== 'string' || !update) continue;

    let updateBytes: Buffer;
    try {
      updateBytes = Buffer.from(update, 'base64');
    } catch {
      continue; // skip malformed entry
    }

    if (replace) {
      compactYjsUpdates(id, updateBytes, yjs_sv_hash ?? null);
    } else {
      appendYjsUpdate(id, updateBytes);
      if (yjs_sv_hash) {
        req.userDbHandle.stmts.updateYjsSvHash.run({ id, yjs_sv_hash });
      }
    }
  }

  return res.status(204).end();
});
