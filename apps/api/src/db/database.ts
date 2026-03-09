import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
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
    id             TEXT    PRIMARY KEY,
    parent_id      TEXT    REFERENCES documents(id) ON DELETE CASCADE,
    type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'workspace', 'image')),
    position       TEXT    NOT NULL DEFAULT 'a0',
    properties     TEXT    NOT NULL DEFAULT '{}',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_struct_ts INTEGER NOT NULL DEFAULT 0
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
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * Incremental migrations keyed by version number.
 * Each migration runs exactly once; the applied version is stored in schema_version.
 * Add new entries to the END of this list only — never renumber existing ones.
 */
const MIGRATIONS: Array<{ version: number; sql?: string; run?: () => void }> = [
  {
    // v1: add last_struct_ts for last-write-wins offline-sync semantics.
    // ALTER TABLE is safe to run on DBs created before this field was in the
    // CREATE TABLE statement above; on new DBs the column already exists (ignored).
    version: 1,
    sql: `ALTER TABLE documents ADD COLUMN last_struct_ts INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // v2: broaden the type CHECK constraint to include 'image'.
    // SQLite does not support ALTER TABLE to change a CHECK constraint, so we
    // recreate the table using the standard SQLite "12-step" rename procedure.
    version: 2,
    run: () => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'workspace', 'image')),
          position       TEXT    NOT NULL DEFAULT 'a0',
          properties     TEXT    NOT NULL DEFAULT '{}',
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          last_struct_ts INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO documents_new SELECT * FROM documents;
        DROP TABLE documents;
        ALTER TABLE documents_new RENAME TO documents;
        CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_documents_type      ON documents(type);
      `);
      db.pragma('foreign_keys = ON');
    },
  },
];

function runMigrations(): void {
  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.run) {
      // Custom migration: runs outside a normal transaction so it can issue
      // PRAGMAs (like foreign_keys = OFF) that must be outside transactions.
      migration.run();
      db.prepare('INSERT INTO schema_version (version, migrated_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    } else {
      db.transaction(() => {
        try {
          db.exec(migration.sql!);
        } catch (err: unknown) {
          // SQLite raises an error if the column already exists (DB was created with the
          // new schema). Treat that as a no-op so the migration still records its version.
          if (err instanceof Error && err.message.includes('duplicate column name')) {
            // column already present — nothing to do
          } else {
            throw err;
          }
        }
        db.prepare('INSERT INTO schema_version (version, migrated_at) VALUES (?, ?)').run(
          migration.version,
          Date.now(),
        );
      })();
    }
  }
}

runMigrations();

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// documents
export const stmts = {
  listDocuments: db.prepare(`
    SELECT id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts
    FROM documents
    ORDER BY position ASC
  `),

  getDocument: db.prepare(`
    SELECT id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts
    FROM documents
    WHERE id = ?
  `),

  insertDocument: db.prepare(`
    INSERT INTO documents (id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts)
    VALUES (@id, @parent_id, @type, @position, @properties, @created_at, @updated_at, @last_struct_ts)
  `),

  updateDocument: db.prepare(`
    UPDATE documents
    SET parent_id      = @parent_id,
        type           = @type,
        position       = @position,
        properties     = @properties,
        updated_at     = @updated_at,
        last_struct_ts = @last_struct_ts
    WHERE id = @id
  `),

  deleteDocument: db.prepare(`DELETE FROM documents WHERE id = ?`),

  /** Update only the properties + updated_at of a document (Yjs write-through cache). */
  updateDocumentProperties: db.prepare(`
    UPDATE documents
    SET properties = @properties,
        updated_at = @updated_at
    WHERE id = @id
  `),

  /**
   * Update position + parent_id + last_struct_ts for a reposition operation.
   * Only called when the LWW check has already passed.
   */
  repositionDocument: db.prepare(`
    UPDATE documents
    SET parent_id      = @parent_id,
        position       = @position,
        updated_at     = @updated_at,
        last_struct_ts = @last_struct_ts
    WHERE id = @id
  `),

  /** Update only properties when replaying an update_properties sync op. */
  syncUpdateProperties: db.prepare(`
    UPDATE documents
    SET properties     = @properties,
        updated_at     = @updated_at,
        last_struct_ts = @last_struct_ts
    WHERE id = @id
  `),

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
