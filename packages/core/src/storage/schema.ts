// ---------------------------------------------------------------------------
// Shared SQLite schema + migrations for the per-user document store.
//
// This is the single, runtime-agnostic source of truth for the storage schema.
// Both the cloud API (better-sqlite3) and the local backend (Phase 3 worker)
// execute these against their own SQLite driver. Nothing here imports a driver.
// ---------------------------------------------------------------------------

/**
 * Compaction threshold: once a document accumulates this many Yjs update rows,
 * the sync layer replaces them with a single squashed snapshot blob.
 */
export const COMPACT_THRESHOLD = 100;

/**
 * Base schema applied to a fresh database. Older databases are brought up to
 * date by {@link MIGRATIONS}; a brand-new database runs this DDL and then every
 * migration in order (which rebuild the `documents` CHECK constraint and add
 * the later columns).
 */
export const SCHEMA_SQL = `
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

/**
 * A single schema migration in runtime-agnostic form. The concrete storage
 * adapter is responsible for executing `statements` (in order) against its
 * driver and recording the applied `version` in `schema_version`.
 */
export interface SchemaMigration {
  version: number;
  /** SQL executed in order. Each entry may itself contain multiple statements. */
  statements: string[];
  /**
   * Wrap execution with `PRAGMA foreign_keys = OFF/ON` and run OUTSIDE a
   * transaction (SQLite ignores the foreign_keys pragma inside a transaction).
   * Used by the table-rebuild migrations that widen the `type` CHECK.
   */
  foreignKeysOff?: boolean;
  /**
   * Tolerate "duplicate column name" errors so re-running an idempotent
   * `ALTER TABLE ... ADD COLUMN` on an already-migrated database is a no-op.
   */
  tolerateDuplicateColumn?: boolean;
}

// Reusable table-rebuild body: recreate `documents` with a widened CHECK and
// copy rows across. `typeCheck` is the CHECK constraint list; `select` is the
// column projection used to repopulate the rebuilt table.
function rebuildDocuments(typeCheck: string, select: string): string {
  return `
    CREATE TABLE documents_new (
      id             TEXT    PRIMARY KEY,
      parent_id      TEXT    REFERENCES documents_new(id) ON DELETE CASCADE,
      type           TEXT    NOT NULL CHECK(type IN (${typeCheck})),
      position       TEXT    NOT NULL DEFAULT 'a0',
      properties     TEXT    NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_struct_ts INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO documents_new ${select};
    DROP TABLE documents;
    ALTER TABLE documents_new RENAME TO documents;
    CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
    CREATE INDEX IF NOT EXISTS idx_documents_type      ON documents(type);
  `;
}

const SELECT_ALL = 'SELECT * FROM documents';
const SELECT_DB_PAGE = `
  SELECT
    id, parent_id,
    CASE
      WHEN type = 'page' AND parent_id IN (SELECT id FROM documents WHERE type = 'db-folder')
      THEN 'db-page'
      ELSE type
    END AS type,
    position, properties, created_at, updated_at, last_struct_ts
  FROM documents`;

/**
 * Incremental migrations keyed by version number.
 * Add new entries to the END only — never renumber existing ones.
 */
export const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    statements: [`ALTER TABLE documents ADD COLUMN last_struct_ts INTEGER NOT NULL DEFAULT 0`],
    tolerateDuplicateColumn: true,
  },
  {
    version: 2,
    foreignKeysOff: true,
    statements: [rebuildDocuments(`'page', 'folder', 'workspace', 'image', 'file'`, SELECT_ALL)],
  },
  {
    // Expand the type CHECK constraint to include the 'file' attachment type.
    version: 3,
    foreignKeysOff: true,
    statements: [rebuildDocuments(`'page', 'folder', 'workspace', 'image', 'file'`, SELECT_ALL)],
  },
  {
    // Expand the type CHECK constraint to include the 'db-folder' datatable folder type.
    version: 4,
    foreignKeysOff: true,
    statements: [
      rebuildDocuments(`'page', 'folder', 'db-folder', 'workspace', 'image', 'file'`, SELECT_ALL),
    ],
  },
  {
    // Expand the type CHECK constraint to include 'block-registry' for the
    // workspace-wide block metadata Yjs document (one per workspace).
    version: 5,
    foreignKeysOff: true,
    statements: [
      rebuildDocuments(
        `'page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry'`,
        SELECT_ALL,
      ),
    ],
  },
  {
    // Introduce 'db-page' as a dedicated document type for row-pages (pages that
    // live inside a db-folder and back a single datatable row). Migrates all
    // existing 'page' docs whose parent is a 'db-folder' to 'db-page'.
    version: 6,
    foreignKeysOff: true,
    statements: [
      rebuildDocuments(
        `'page', 'db-page', 'folder', 'db-folder', 'workspace', 'image', 'file', 'block-registry'`,
        SELECT_DB_PAGE,
      ),
    ],
  },
  {
    // Add archival/trash status bitfield columns.
    version: 7,
    statements: [
      `ALTER TABLE documents ADD COLUMN status           INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documents ADD COLUMN status_timestamp INTEGER`,
    ],
    tolerateDuplicateColumn: true,
  },
  {
    // Add last_properties_ts for independent LWW tracking of property changes.
    // Previously update_properties ops were guarded by last_struct_ts, which
    // reposition also updates — causing renames to be silently dropped when a
    // concurrent reposition had advanced last_struct_ts on the other device.
    version: 8,
    statements: [`ALTER TABLE documents ADD COLUMN last_properties_ts INTEGER NOT NULL DEFAULT 0`],
    tolerateDuplicateColumn: true,
  },
  {
    // Add yjs_sv_hash — SHA-256 of the Yjs state vector, used to skip unchanged
    // documents during initial sync (hash match ⇒ identical CRDT state).
    version: 9,
    statements: [`ALTER TABLE documents ADD COLUMN yjs_sv_hash TEXT`],
    tolerateDuplicateColumn: true,
  },
];

/** True when `err` is a SQLite "duplicate column name" error. */
export function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('duplicate column name');
}
