import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type {
  Document,
  DocumentType,
  CreateDocumentPayload,
  UpdateDocumentPayload,
  RepositionDocumentPayload,
  StructOp,
  SyncStructuralPayload,
  SyncStructuralResult,
} from '@notefinity/types';
import { generateKeyBetween } from '@notefinity/utils';
import { db, stmts } from '../db/database';

export const documentsRouter = Router();

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
  };
}

// ---------------------------------------------------------------------------
// GET /api/documents
// Returns ALL documents (tree data — client builds the hierarchy).
// ---------------------------------------------------------------------------
documentsRouter.get('/', (_req: Request, res: Response) => {
  const rows = stmts.listDocuments.all() as DocumentRow[];
  res.json(rows.map(toOut));
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id
// ---------------------------------------------------------------------------
documentsRouter.get('/:id', (req: Request, res: Response) => {
  const row = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  res.json(toOut(row));
});

// ---------------------------------------------------------------------------
// POST /api/documents
// Body: { parent_id?, type, position?, properties? }
// ---------------------------------------------------------------------------
documentsRouter.post('/', (req: Request, res: Response) => {
  const { parent_id = null, type, properties = {} } = req.body as CreateDocumentPayload;

  // Derive position: place after the last sibling, or use the client-supplied value if present.
  const lastRow = stmts.lastSiblingPosition.get(parent_id) as { position: string } | undefined;
  const position = (req.body as CreateDocumentPayload).position
    ?? generateKeyBetween(lastRow?.position ?? null, null);

  if (!type || !['page', 'folder', 'workspace'].includes(type)) {
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
  res.status(201).json(toOut({ ...doc }));
});

// ---------------------------------------------------------------------------
// PUT /api/documents/:id
// Body: { parent_id?, type?, position?, properties? }
// Partial update — only provided fields are changed.
// ---------------------------------------------------------------------------
documentsRouter.put('/:id', (req: Request, res: Response) => {
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
  res.json(toOut({ ...updated, created_at: existing.created_at }));
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/reposition
// Body: { parent_id: string | null, before_id: string | null, client_ts?: number }
// Moves the document under parent_id, placing it immediately before before_id.
// Pass before_id: null to append at the end of the sibling list.
// If client_ts is supplied, last-write-wins semantics are applied: the operation
// is skipped (returning the current doc state) when a newer op has already won.
// ---------------------------------------------------------------------------
documentsRouter.patch('/:id/reposition', (req: Request, res: Response) => {
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const { parent_id = null, before_id = null, client_ts } = req.body as RepositionDocumentPayload;

  // LWW check: if caller supplied a timestamp and a newer structural op has
  // already been applied, return current state without mutating anything.
  if (client_ts !== undefined && client_ts <= existing.last_struct_ts) {
    return res.json(toOut(existing));
  }

  let position: string;

  if (before_id === null) {
    // Append after the last sibling in the target parent.
    const lastRow = stmts.lastSiblingPosition.get(parent_id) as { position: string } | undefined;
    // Exclude the document itself when it is already in this parent.
    const lastPos = lastRow && lastRow.position !== existing.position ? lastRow.position : null;
    position = generateKeyBetween(lastPos, null);
  } else {
    // Insert immediately before before_id.
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
        if (!payload.type || !['page', 'folder', 'workspace'].includes(payload.type)) {
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
  res.json(result);
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id
// Cascades to child documents and yjs_updates via FK constraint.
// ---------------------------------------------------------------------------
documentsRouter.delete('/:id', (req: Request, res: Response) => {
  const existing = stmts.getDocument.get(req.params.id) as DocumentRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  stmts.deleteDocument.run(req.params.id);
  res.status(204).end();
});
