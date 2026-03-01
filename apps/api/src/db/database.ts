import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'notefinity.db');

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id        TEXT    PRIMARY KEY,
    parent_id TEXT    REFERENCES documents(id) ON DELETE CASCADE,
    type      TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'workspace')),
    position  TEXT    NOT NULL DEFAULT 'a0',
    properties TEXT   NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS yjs_updates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    data        BLOB    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     INTEGER NOT NULL,
    migrated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_parent_id   ON documents(parent_id);
  CREATE INDEX IF NOT EXISTS idx_documents_type        ON documents(type);
  CREATE INDEX IF NOT EXISTS idx_yjs_updates_document  ON yjs_updates(document_id);
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// documents
export const stmts = {
  listDocuments: db.prepare(`
    SELECT id, parent_id, type, position, properties, created_at, updated_at
    FROM documents
    ORDER BY position ASC
  `),

  getDocument: db.prepare(`
    SELECT id, parent_id, type, position, properties, created_at, updated_at
    FROM documents
    WHERE id = ?
  `),

  insertDocument: db.prepare(`
    INSERT INTO documents (id, parent_id, type, position, properties, created_at, updated_at)
    VALUES (@id, @parent_id, @type, @position, @properties, @created_at, @updated_at)
  `),

  updateDocument: db.prepare(`
    UPDATE documents
    SET parent_id  = @parent_id,
        type       = @type,
        position   = @position,
        properties = @properties,
        updated_at = @updated_at
    WHERE id = @id
  `),

  deleteDocument: db.prepare(`DELETE FROM documents WHERE id = ?`),

  /** Returns the highest position value among siblings sharing the same parent_id. */
  lastSiblingPosition: db.prepare(`
    SELECT position FROM documents
    WHERE parent_id IS ?
    ORDER BY position DESC
    LIMIT 1
  `),

  /**
   * Returns the highest position value among siblings that sort strictly before
   * a given position, excluding a specific document id (the one being moved).
   */
  siblingPositionBefore: db.prepare(`
    SELECT position FROM documents
    WHERE parent_id IS @parent_id
      AND position < @before_pos
      AND id != @exclude_id
    ORDER BY position DESC
    LIMIT 1
  `),

  // yjs_updates
  getYjsUpdates: db.prepare(`
    SELECT data FROM yjs_updates
    WHERE document_id = ?
    ORDER BY id ASC
  `),

  countYjsUpdates: db.prepare(`
    SELECT COUNT(*) as count FROM yjs_updates WHERE document_id = ?
  `),

  appendYjsUpdate: db.prepare(`
    INSERT INTO yjs_updates (document_id, data, created_at)
    VALUES (@document_id, @data, @created_at)
  `),

  compactYjsUpdates: db.prepare(`
    DELETE FROM yjs_updates WHERE document_id = ?
  `),
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns all raw binary Yjs updates for a document, oldest-first. */
export function getYjsUpdates(documentId: string): Buffer[] {
  const rows = stmts.getYjsUpdates.all(documentId) as { data: Buffer }[];
  return rows.map((r) => r.data);
}

/** Appends a single binary Yjs update delta for a document. */
export function appendYjsUpdate(documentId: string, update: Uint8Array): void {
  stmts.appendYjsUpdate.run({
    document_id: documentId,
    data: Buffer.from(update),
    created_at: Date.now(),
  });
}

/** Replaces all update rows for a document with a single compacted snapshot. */
export function compactYjsUpdates(documentId: string, snapshot: Uint8Array): void {
  db.transaction(() => {
    stmts.compactYjsUpdates.run(documentId);
    stmts.appendYjsUpdate.run({
      document_id: documentId,
      data: Buffer.from(snapshot),
      created_at: Date.now(),
    });
  })();
}

/** Returns the number of update rows for a document. */
export function countYjsUpdates(documentId: string): number {
  const row = stmts.countYjsUpdates.get(documentId) as { count: number };
  return row.count;
}

/** Compaction threshold — matches notefinity17 behaviour. */
export const COMPACT_THRESHOLD = 100;
