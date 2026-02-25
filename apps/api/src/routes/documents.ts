import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { Document, DocumentType, CreateDocumentPayload, UpdateDocumentPayload } from '@notefinity/types';
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
}

function toOut(row: DocumentRow): Document {
  return {
    ...row,
    properties: JSON.parse(row.properties),
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
  const { parent_id = null, type, position = 'a0', properties = {} } = req.body as CreateDocumentPayload;

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
  };

  stmts.insertDocument.run(doc);
  res.status(201).json(toOut({ ...doc, properties: JSON.stringify(properties) }));
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
    parent_id:  parent_id  !== undefined ? parent_id  : existing.parent_id,
    type:       type        !== undefined ? type        : existing.type,
    position:   position    !== undefined ? position    : existing.position,
    properties: properties  !== undefined
      ? JSON.stringify(properties)
      : existing.properties,
    updated_at: Date.now(),
  };

  stmts.updateDocument.run(updated);
  res.json(toOut({ ...updated, created_at: existing.created_at }));
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
