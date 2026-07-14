import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type { StoragePort } from '@ubimate/core';
import {
  SCHEMA_SQL,
  MIGRATIONS,
  COMPACT_THRESHOLD as CORE_COMPACT_THRESHOLD,
  isDuplicateColumnError,
} from '@ubimate/core';
import { createSqliteStoragePort } from './sqliteStoragePort';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Re-exported from @ubimate/core (single source of truth for the policy). */
export const COMPACT_THRESHOLD = CORE_COMPACT_THRESHOLD;
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5000);

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
  /**
   * The runtime-agnostic {@link StoragePort} (better-sqlite3 implementation).
   * Non-transactional callers should prefer this; transactional batch paths
   * still use `db`/`stmts` directly (better-sqlite3 transactions are sync).
   */
  storage: StoragePort;
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
// Migrations
//
// The schema DDL and the migration list live in @ubimate/core (the single,
// runtime-agnostic source of truth shared with the local backend). This module
// is the better-sqlite3 executor for those portable definitions.
// ---------------------------------------------------------------------------

function runMigrations(db: Database.Database): void {
  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0;

  const recordVersion = (version: number) =>
    db.prepare('INSERT INTO schema_version (version, migrated_at) VALUES (?, ?)').run(
      version,
      Date.now(),
    );

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const execStatements = () => {
      for (const sql of migration.statements) {
        try {
          db.exec(sql);
        } catch (err: unknown) {
          if (migration.tolerateDuplicateColumn && isDuplicateColumnError(err)) {
            // column already present — nothing to do
          } else {
            throw err;
          }
        }
      }
    };

    if (migration.foreignKeysOff) {
      // The table-rebuild migrations toggle foreign_keys, which SQLite ignores
      // inside a transaction — so run them outside one.
      db.pragma('foreign_keys = OFF');
      execStatements();
      db.pragma('foreign_keys = ON');
      recordVersion(migration.version);
    } else {
      db.transaction(() => {
        execStatements();
        recordVersion(migration.version);
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
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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
      stmts.appendYjsUpdate.run({
        document_id: documentId,
        data: Buffer.from(update),
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
        data: Buffer.from(snapshot),
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

  const storage = createSqliteStoragePort({
    stmts,
    getYjsUpdates,
    appendYjsUpdate,
    compactYjsUpdates,
    countYjsUpdates,
  });

  return { db, stmts, storage, getYjsUpdates, appendYjsUpdate, compactYjsUpdates, countYjsUpdates, findWorkspaceId };
}
