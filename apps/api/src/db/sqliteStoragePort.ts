import type {
  StoragePort,
  StoredDocument,
  InsertDocumentInput,
} from '@ubimate/core';

/**
 * The subset of a {@link UserDbHandle} the storage adapter needs. Declared
 * structurally (rather than importing UserDbHandle) to avoid a circular import
 * with database.ts, which constructs the port as part of the handle.
 */
export interface SqliteStorageBackend {
  stmts: {
    listDocuments: { all(): unknown[] };
    getDocument: { get(id: string): unknown };
    insertDocument: { run(input: Record<string, unknown>): unknown };
    updateDocument: { run(input: Record<string, unknown>): unknown };
    deleteDocument: { run(id: string, statusTs: number, updatedAt: number): unknown };
    deleteYjsUpdatesForSubtree: { run(id: string): unknown };
    repositionDocument: { run(input: Record<string, unknown>): unknown };
    updateDocumentStatus: { run(input: Record<string, unknown>): unknown };
    updateDocumentProperties: { run(input: Record<string, unknown>): unknown };
    syncUpdateProperties: { run(input: Record<string, unknown>): unknown };
    lastSiblingPosition: { get(parentId: string | null): unknown };
    siblingPositionBefore: { get(input: Record<string, unknown>): unknown };
    ensureDocument: { run(input: Record<string, unknown>): unknown };
    ensureBlockRegistryDocument: { run(input: Record<string, unknown>): unknown };
    updateYjsSvHash: { run(input: Record<string, unknown>): unknown };
  };
  getYjsUpdates(documentId: string): Buffer[];
  appendYjsUpdate(documentId: string, update: Uint8Array): void;
  compactYjsUpdates(documentId: string, snapshot: Uint8Array, yjsSvHash?: string | null): void;
  countYjsUpdates(documentId: string): number;
}

/**
 * The cloud (better-sqlite3) implementation of the runtime-agnostic
 * {@link StoragePort} from @ubimate/core. better-sqlite3 is synchronous, so
 * each method wraps a synchronous prepared-statement call in an async
 * signature. It stores whatever bytes/JSON it is given verbatim — it is
 * encryption-agnostic and never interprets `properties` or Yjs blobs.
 *
 * Transactional batch operations (e.g. offline structural-sync replay) are NOT
 * expressed through this async port: better-sqlite3 transactions must run
 * synchronously, so those paths keep using the synchronous statements directly.
 */
export function createSqliteStoragePort(backend: SqliteStorageBackend): StoragePort {
  const { stmts } = backend;

  return {
    async listDocuments(): Promise<StoredDocument[]> {
      return stmts.listDocuments.all() as StoredDocument[];
    },

    async getDocument(id): Promise<StoredDocument | null> {
      return (stmts.getDocument.get(id) as StoredDocument | undefined) ?? null;
    },

    async insertDocument(input: InsertDocumentInput): Promise<void> {
      stmts.insertDocument.run(input as unknown as Record<string, unknown>);
    },

    async updateDocument(input: InsertDocumentInput): Promise<void> {
      stmts.updateDocument.run(input as unknown as Record<string, unknown>);
    },

    async deleteDocument(id, statusTimestamp, updatedAt): Promise<void> {
      stmts.deleteDocument.run(id, statusTimestamp, updatedAt);
      stmts.deleteYjsUpdatesForSubtree.run(id);
    },

    async repositionDocument(input): Promise<void> {
      stmts.repositionDocument.run(input as unknown as Record<string, unknown>);
    },

    async updateDocumentStatus(input): Promise<void> {
      stmts.updateDocumentStatus.run(input as unknown as Record<string, unknown>);
    },

    async updateDocumentProperties(input): Promise<void> {
      if (input.last_properties_ts !== undefined) {
        stmts.syncUpdateProperties.run({
          id: input.id,
          properties: input.properties,
          updated_at: input.updated_at,
          last_properties_ts: input.last_properties_ts,
        });
      } else {
        stmts.updateDocumentProperties.run({
          id: input.id,
          properties: input.properties,
          updated_at: input.updated_at,
        });
      }
    },

    async ensureDocument(id): Promise<void> {
      stmts.ensureDocument.run({ id, ts: Date.now() });
    },

    async ensureBlockRegistryDocument(id): Promise<void> {
      stmts.ensureBlockRegistryDocument.run({ id, ts: Date.now() });
    },

    async lastSiblingPosition(parentId): Promise<string | null> {
      const row = stmts.lastSiblingPosition.get(parentId) as { position: string } | undefined;
      return row?.position ?? null;
    },

    async siblingPositionBefore(input): Promise<string | null> {
      const row = stmts.siblingPositionBefore.get(input) as { position: string } | undefined;
      return row?.position ?? null;
    },

    async getYjsUpdates(documentId): Promise<Uint8Array[]> {
      // Buffer is a Uint8Array subclass — the opaque bytes pass through as-is.
      return backend.getYjsUpdates(documentId);
    },

    async appendYjsUpdate(documentId, update): Promise<void> {
      backend.appendYjsUpdate(documentId, update);
    },

    async countYjsUpdates(documentId): Promise<number> {
      return backend.countYjsUpdates(documentId);
    },

    async compactYjsUpdates(documentId, snapshot, yjsSvHash): Promise<void> {
      backend.compactYjsUpdates(documentId, snapshot, yjsSvHash);
    },

    async deleteYjsUpdatesForSubtree(documentId): Promise<void> {
      stmts.deleteYjsUpdatesForSubtree.run(documentId);
    },

    async updateYjsSvHash(id, yjsSvHash): Promise<void> {
      stmts.updateYjsSvHash.run({ id, yjs_sv_hash: yjsSvHash });
    },
  };
}
