import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COMPACT_THRESHOLD = 100;

const YJS_DB_ENCRYPTION_MAGIC = Buffer.from('SYE1');
const YJS_DB_ENCRYPTION_IV_BYTES = 12;
const YJS_DB_ENCRYPTION_TAG_BYTES = 16;

function deriveYjsDbEncryptionKey(): Buffer {
  const explicit = process.env.YJS_DB_ENCRYPTION_KEY;
  if (explicit && explicit.trim().length > 0) {
    return createHash('sha256').update(explicit).digest();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('YJS_DB_ENCRYPTION_KEY environment variable must be set in production');
  }

  // Dev/test fallback for convenience in local runs.
  console.warn('[yjs-db] YJS_DB_ENCRYPTION_KEY not set — deriving from JWT_SECRET (dev/test only)');
  const material = process.env.JWT_SECRET ?? 'sovernote-dev-secret-change-in-production';
  return createHash('sha256').update(material).digest();
}

const YJS_DB_ENCRYPTION_KEY = deriveYjsDbEncryptionKey();

function encryptYjsUpdateForStorage(plaintext: Uint8Array): Buffer {
  const iv = randomBytes(YJS_DB_ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', YJS_DB_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([YJS_DB_ENCRYPTION_MAGIC, iv, tag, ciphertext]);
}

function decryptYjsUpdateFromStorage(stored: Buffer): Buffer {
  const minLength =
    YJS_DB_ENCRYPTION_MAGIC.length + YJS_DB_ENCRYPTION_IV_BYTES + YJS_DB_ENCRYPTION_TAG_BYTES;
  if (stored.length < minLength) {
    throw new Error('Invalid encrypted Yjs row: payload too short');
  }
  if (!stored.subarray(0, YJS_DB_ENCRYPTION_MAGIC.length).equals(YJS_DB_ENCRYPTION_MAGIC)) {
    throw new Error('Invalid encrypted Yjs row: missing header');
  }

  const ivStart = YJS_DB_ENCRYPTION_MAGIC.length;
  const ivEnd = ivStart + YJS_DB_ENCRYPTION_IV_BYTES;
  const tagEnd = ivEnd + YJS_DB_ENCRYPTION_TAG_BYTES;

  const iv = stored.subarray(ivStart, ivEnd);
  const tag = stored.subarray(ivEnd, tagEnd);
  const ciphertext = stored.subarray(tagEnd);

  const decipher = createDecipheriv('aes-256-gcm', YJS_DB_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserStmts {
  listDocuments: Statement;
  getDocument: Statement;
  insertDocument: Statement;
  updateDocument: Statement;
  deleteDocument: Statement;
  deleteYjsUpdatesForSubtree: Statement;
  archiveDocument: Statement;
  unarchiveDocument: Statement;
  updateDocumentStatus: Statement;
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
  updateYjsSvHash: Statement;
}

export interface UserDbHandle {
  db: Database.Database;
  stmts: UserStmts;
  getYjsUpdates(documentId: string): Buffer[];
  appendYjsUpdate(documentId: string, update: Uint8Array): void;
  compactYjsUpdates(documentId: string, snapshot: Uint8Array, yjsSvHash?: string | null): void;
  countYjsUpdates(documentId: string): number;
  /**
   * Traverse the parent chain for `documentId` and return the ID of the
   * nearest ancestor whose `type = 'workspace'`, or null if not found.
   */
  findWorkspaceId(documentId: string): string | null;
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
  {
    // Introduce 'db-page' as a dedicated document type for row-pages (pages
    // that live inside a db-folder and back a single datatable row).
    // Migrates all existing 'page' docs whose parent is a 'db-folder' to 'db-page'.
    version: 6,
    run: (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE documents_new (
          id             TEXT    PRIMARY KEY,
          parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
          type           TEXT    NOT NULL CHECK(type IN ('page', 'db-page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry')),
          position       TEXT    NOT NULL DEFAULT 'a0',
          properties     TEXT    NOT NULL DEFAULT '{}',
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          last_struct_ts INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO documents_new
          SELECT
            id, parent_id,
            CASE
              WHEN type = 'page' AND parent_id IN (SELECT id FROM documents WHERE type = 'db-folder')
              THEN 'db-page'
              ELSE type
            END AS type,
            position, properties, created_at, updated_at, last_struct_ts
          FROM documents;
        DROP TABLE documents;
        ALTER TABLE documents_new RENAME TO documents;
        CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_documents_type      ON documents(type);
      `);
      db.pragma('foreign_keys = ON');
    },
  },
  {
    // Add archival/trash status bitfield columns.
    version: 7,
    run: (db) => {
      for (const sql of [
        `ALTER TABLE documents ADD COLUMN status           INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE documents ADD COLUMN status_timestamp INTEGER`,
      ]) {
        try { db.exec(sql); } catch (err: unknown) {
          if (err instanceof Error && err.message.includes('duplicate column name')) {
            /* already present — skip */
          } else { throw err; }
        }
      }
    },
  },
  {
    // Add last_properties_ts for independent LWW tracking of property changes.
    // Previously update_properties ops were guarded by last_struct_ts, which
    // reposition also updates — causing renames to be silently dropped when a
    // concurrent reposition had advanced last_struct_ts on the other device.
    version: 8,
    run: (db) => {
      try {
        db.exec(`ALTER TABLE documents ADD COLUMN last_properties_ts INTEGER NOT NULL DEFAULT 0`);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('duplicate column name')) {
          /* already present — skip */
        } else { throw err; }
      }
    },
  },
  {
    // Add yjs_sv_hash — SHA-256 of the Yjs state vector, used to skip unchanged
    // documents during initial sync (hash match ⇒ identical CRDT state).
    version: 9,
    run: (db) => {
      try {
        db.exec(`ALTER TABLE documents ADD COLUMN yjs_sv_hash TEXT`);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('duplicate column name')) {
          /* already present — skip */
        } else { throw err; }
      }
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
      SELECT id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts,
             status, status_timestamp, last_properties_ts, yjs_sv_hash
      FROM documents
      WHERE type != 'block-registry'
      ORDER BY position ASC
    `),
    getDocument: db.prepare(`
      SELECT id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts,
             status, status_timestamp, last_properties_ts, yjs_sv_hash
      FROM documents
      WHERE id = ?
    `),
    insertDocument: db.prepare(`
      INSERT INTO documents (id, parent_id, type, position, properties, created_at, updated_at, last_struct_ts, status, status_timestamp, last_properties_ts)
      VALUES (@id, @parent_id, @type, @position, @properties, @created_at, @updated_at, @last_struct_ts, @status, @status_timestamp, @last_properties_ts)
    `),
    updateDocument: db.prepare(`
      UPDATE documents
      SET parent_id          = @parent_id,
          type               = @type,
          position           = @position,
          properties         = @properties,
          updated_at         = @updated_at,
          last_struct_ts     = @last_struct_ts,
          last_properties_ts = @last_properties_ts
      WHERE id = @id
    `),
    deleteDocument: db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM documents WHERE id = ?
        UNION ALL
        SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
      )
      UPDATE documents SET status = 4, status_timestamp = ?, updated_at = ?
      WHERE id IN (SELECT id FROM subtree)
    `),
    deleteYjsUpdatesForSubtree: db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM documents WHERE id = ?
        UNION ALL
        SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
      )
      DELETE FROM yjs_updates WHERE document_id IN (SELECT id FROM subtree)
    `),
    archiveDocument: db.prepare(`UPDATE documents SET status = status | 1, status_timestamp = ?, updated_at = ? WHERE id = ?`),
    unarchiveDocument: db.prepare(`UPDATE documents SET status = (status & ~1), status_timestamp = ?, updated_at = ? WHERE id = ?`),
    updateDocumentStatus: db.prepare(`UPDATE documents SET status = @status, status_timestamp = @status_timestamp, updated_at = @updated_at WHERE id = @id`),
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
      SET properties         = @properties,
          updated_at         = @updated_at,
          last_properties_ts = @last_properties_ts
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
    updateYjsSvHash: db.prepare(`
      UPDATE documents SET yjs_sv_hash = @yjs_sv_hash WHERE id = @id
    `),
  };

  function getYjsUpdates(documentId: string): Buffer[] {
    const rows = stmts.getYjsUpdates.all(documentId) as { data: Buffer }[];
    return rows.map((r) => decryptYjsUpdateFromStorage(r.data));
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
      stmts.appendYjsUpdate.run({
        document_id: documentId,
        data: encryptYjsUpdateForStorage(update),
        created_at: now,
      });
      // Invalidate the cached hash — new content makes the stored hash stale.
      stmts.updateYjsSvHash.run({ id: documentId, yjs_sv_hash: null });
    })();
  }

  function compactYjsUpdates(documentId: string, snapshot: Uint8Array, yjsSvHash?: string | null): void {
    db.transaction(() => {
      stmts.compactYjsUpdates.run(documentId);
      stmts.appendYjsUpdate.run({
        document_id: documentId,
        data: encryptYjsUpdateForStorage(snapshot),
        created_at: Date.now(),
      });
      if (yjsSvHash !== undefined) {
        stmts.updateYjsSvHash.run({ id: documentId, yjs_sv_hash: yjsSvHash });
      }
    })();
  }

  function countYjsUpdates(documentId: string): number {
    const row = stmts.countYjsUpdates.get(documentId) as { count: number };
    return row.count;
  }

  function findWorkspaceId(documentId: string): string | null {
    let id: string | null = documentId;
    // Traverse up the parent chain (max 50 levels to guard against cycles).
    for (let depth = 0; depth < 50 && id !== null; depth++) {
      const row = stmts.getDocument.get(id) as
        | { id: string; parent_id: string | null; type: string }
        | undefined;
      if (!row) return null;
      if (row.type === 'workspace') return row.id;
      id = row.parent_id;
    }
    return null;
  }

  return { db, stmts, getYjsUpdates, appendYjsUpdate, compactYjsUpdates, countYjsUpdates, findWorkspaceId };
}
