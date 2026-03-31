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
} from '@sovernote/types';
import { generateKeyBetween } from '@sovernote/utils';
import { requireAuth } from '../middleware/auth';

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
  status: number;
  status_timestamp: number | null;
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
  };
}

// ---------------------------------------------------------------------------
// GET /api/documents
// Returns ALL documents (tree data — client builds the hierarchy).
// ---------------------------------------------------------------------------
documentsRouter.get('/', (_req: Request, res: Response) => {
  const rows = _req.userDbHandle.stmts.listDocuments.all() as DocumentRow[];
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
documentsRouter.get('/:id', (req: Request, res: Response) => {
  const row = req.userDbHandle.stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
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

  // Derive position: place after the last sibling, or use the client-supplied value if present.
  const lastRow = stmts.lastSiblingPosition.get(parent_id) as { position: string } | undefined;
  const position = (req.body as CreateDocumentPayload).position
    ?? generateKeyBetween(lastRow?.position ?? null, null);

  if (!type || !['page', 'db-page', 'folder', 'db-folder', 'workspace', 'image', 'file'].includes(type)) {
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
  };

  stmts.insertDocument.run(doc);
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
    parent_id:     parent_id  !== undefined ? parent_id  : existing.parent_id,
    type:          type        !== undefined ? type        : existing.type,
    position:      position    !== undefined ? position    : existing.position,
    properties:    properties  !== undefined
      ? JSON.stringify(properties)
      : existing.properties,
    updated_at:    Date.now(),
    last_struct_ts: existing.last_struct_ts,
  };

  stmts.updateDocument.run(updated);
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

  // Sort ascending so older decisions are applied first; newer ones overwrite.
  const sorted = [...ops].sort((a, b) => a.client_ts - b.client_ts);

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

        const payload = op.payload as CreateDocumentPayload;
        if (!payload.type || !['page', 'db-page', 'folder', 'db-folder', 'workspace'].includes(payload.type)) {
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
          last_struct_ts: op.client_ts,
        });
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
        if (op.client_ts <= existing.last_struct_ts) { skipped++; continue; }

        stmts.deleteDocument.run(op.id);
        applied++;
        continue;
      }

      if (op.op === 'reposition') {
        if (!existing) { skipped++; continue; }
        if (op.client_ts <= existing.last_struct_ts) { skipped++; continue; }

        const { parent_id = null, before_id = null } =
          op.payload as RepositionDocumentPayload;

        let position: string;
        if (before_id === null) {
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
        if (op.client_ts <= existing.last_struct_ts) { skipped++; continue; }

        const payload = op.payload as UpdateDocumentPayload;
        stmts.syncUpdateProperties.run({
          id:            op.id,
          properties:    JSON.stringify(payload.properties ?? JSON.parse(existing.properties)),
          updated_at:    op.client_ts,
          last_struct_ts: op.client_ts,
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
  const now = Date.now();
  db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM documents WHERE id = ?
      UNION ALL
      SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
    )
    UPDATE documents SET status = status | 2, status_timestamp = ?
    WHERE id IN (SELECT id FROM subtree)
  `).run(req.params.id, now);
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
    UPDATE documents SET status = (status & ~2), status_timestamp = ?
    WHERE id IN (SELECT id FROM subtree)
  `).run(req.params.id, now);
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
  stmts.archiveDocument.run(Date.now(), req.params.id);
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
  stmts.unarchiveDocument.run(Date.now(), req.params.id);
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

  // deleteDocument prepared statement already deletes the whole subtree via recursive CTE.
  stmts.deleteDocument.run(req.params.id);
  broadcastTreeChanged(req.userId);
  res.status(204).end();
});
