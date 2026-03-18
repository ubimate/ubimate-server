import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COMPACT_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserStmts {
  listDocuments: Statement;
  getDocument: Statement;
  insertDocument: Statement;
  updateDocument: Statement;
  deleteDocument: Statement;
  updateDocumentProperties: Statement;
  repositionDocument: Statement;
  syncUpdateProperties: Statement;
  lastSiblingPosition: Statement;
  siblingPositionBefore: Statement;
  getYjsUpdates: Statement;
  countYjsUpdates: Statement;
  ensureDocument: Statement;
  ensureBlockRegistryDocument: Statement;
  appendYjsUpdate: Statement;
  compactYjsUpdates: Statement;
}

export interface UserDbHandle {
  db: Database.Database;
  stmts: UserStmts;
  getYjsUpdates(documentId: string): Buffer[];
  appendYjsUpdate(documentId: string, update: Uint8Array): void;
  compactYjsUpdates(documentId: string, snapshot: Uint8Array): void;
  countYjsUpdates(documentId: string): number;
}

// ---------------------------------------------------------------------------
// Schema SQL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS documents (
    id             TEXT    PRIMARY KEY,
    parent_id      TEXT    REFERENCES documents(id) ON DELETE CASCADE,
    type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'db-folder', 'workspace', 'image', 'file')),
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
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

type Migration = { version: number; sql?: string; run?: (db: Database.Database) => void };

/**
 * Incremental migrations keyed by version number.
 * Add new entries to the END only — never renumber existing ones.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `ALTER TABLE documents ADD COLUMN last_struct_ts INTEGER NOT NULL DEFAULT 0`,
  },
  {
    version: 2,
    run: (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'workspace', 'image', 'file')),
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
  {
    // Expand the type CHECK constraint to include the 'file' attachment type.
    version: 3,
    run: (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'workspace', 'image', 'file')),
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
  {
    // Expand the type CHECK constraint to include the 'db-folder' datatable folder type.
    version: 4,
    run: (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'db-folder', 'workspace', 'image', 'file')),
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
  {
    // Expand the type CHECK constraint to include 'block-registry' for the
    // workspace-wide block metadata Yjs document (one per workspace).
    version: 5,
    run: (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry')),
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

function runMigrations(db: Database.Database): void {
  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.run) {
      migration.run(db);
      db.prepare('INSERT INTO schema_version (version, migrated_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    } else {
      db.transaction(() => {
        try {
          db.exec(migration.sql!);
        } catch (err: unknown) {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Opens a SQLite database at `dbPath`, applies the schema and all pending
 * migrations, prepares all statements, and returns a UserDbHandle.
 * Caching is the responsibility of userDb.ts.
 */
export function initUserDb(dbPath: string): UserDbHandle {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA_SQL);
  runMigrations(db);

  const stmts: UserStmts = {
    listDocuments: db.prepare(`
      SELECT id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts
      FROM documents
      WHERE type != 'block-registry'
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
    updateDocumentProperties: db.prepare(`
      UPDATE documents
      SET properties = @properties,
          updated_at = @updated_at
      WHERE id = @id
    `),
    repositionDocument: db.prepare(`
      UPDATE documents
      SET parent_id      = @parent_id,
          position       = @position,
          updated_at     = @updated_at,
          last_struct_ts = @last_struct_ts
      WHERE id = @id
    `),
    syncUpdateProperties: db.prepare(`
      UPDATE documents
      SET properties     = @properties,
          updated_at     = @updated_at,
          last_struct_ts = @last_struct_ts
      WHERE id = @id
    `),
    lastSiblingPosition: db.prepare(`
      SELECT position FROM documents
      WHERE parent_id IS ?
      ORDER BY position DESC
      LIMIT 1
    `),
    siblingPositionBefore: db.prepare(`
      SELECT position FROM documents
      WHERE parent_id IS @parent_id
        AND position < @before_pos
        AND id != @exclude_id
      ORDER BY position DESC
      LIMIT 1
    `),
    getYjsUpdates: db.prepare(`
      SELECT data FROM yjs_updates
      WHERE document_id = ?
      ORDER BY id ASC
    `),
    countYjsUpdates: db.prepare(`
      SELECT COUNT(*) as count FROM yjs_updates WHERE document_id = ?
    `),
    ensureDocument: db.prepare(`
      INSERT OR IGNORE INTO documents (id, type, position, properties, created_at, updated_at)
      VALUES (@id, 'page', '0', '{}', @ts, @ts)
    `),
    ensureBlockRegistryDocument: db.prepare(`
      INSERT OR IGNORE INTO documents (id, type, position, properties, created_at, updated_at)
      VALUES (@id, 'block-registry', '0', '{}', @ts, @ts)
    `),
    appendYjsUpdate: db.prepare(`
      INSERT INTO yjs_updates (document_id, data, created_at)
      VALUES (@document_id, @data, @created_at)
    `),
    compactYjsUpdates: db.prepare(`
      DELETE FROM yjs_updates WHERE document_id = ?
    `),
  };

  function getYjsUpdates(documentId: string): Buffer[] {
    const rows = stmts.getYjsUpdates.all(documentId) as { data: Buffer }[];
    return rows.map((r) => r.data);
  }

  function appendYjsUpdate(documentId: string, update: Uint8Array): void {
    const now = Date.now();
    db.transaction(() => {
      // Ensure the document row exists — guards against the race where Hocuspocus
      // fires onChange before the REST API has committed the create call.
      // Block-registry documents use their own type; all others default to 'page'.
      if (documentId.startsWith('block-registry:')) {
        stmts.ensureBlockRegistryDocument.run({ id: documentId, ts: now });
      } else {
        stmts.ensureDocument.run({ id: documentId, ts: now });
      }
      stmts.appendYjsUpdate.run({ document_id: documentId, data: Buffer.from(update), created_at: now });
    })();
  }

  function compactYjsUpdates(documentId: string, snapshot: Uint8Array): void {
    db.transaction(() => {
      stmts.compactYjsUpdates.run(documentId);
      stmts.appendYjsUpdate.run({
        document_id: documentId,
        data: Buffer.from(snapshot),
        created_at: Date.now(),
      });
    })();
  }

  function countYjsUpdates(documentId: string): number {
    const row = stmts.countYjsUpdates.get(documentId) as { count: number };
    return row.count;
  }

  return { db, stmts, getYjsUpdates, appendYjsUpdate, compactYjsUpdates, countYjsUpdates };
}
