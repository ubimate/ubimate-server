import type { DocumentType } from '@ubimate/types';

// ---------------------------------------------------------------------------
// Storage contract shared by the cloud API (better-sqlite3) and the local
// backend (Phase 3 webview worker). It is ENCRYPTION-AGNOSTIC: it moves opaque
// blobs + structural metadata and never knows about keys. The local adapter
// stores plaintext; the cloud adapter stores ciphertext. Content-reading logic
// lives elsewhere (client/local only) — never behind this port.
// ---------------------------------------------------------------------------

/**
 * A row of the `documents` table at the storage level. `properties` is an
 * opaque string (JSON text) the storage layer never interprets — on the cloud
 * it is the client's `{ "_enc": "…" }` ciphertext envelope.
 */
export interface StoredDocument {
  id: string;
  parent_id: string | null;
  type: DocumentType;
  /** Fractional-index string for stable ordering within a parent. */
  position: string;
  /** Opaque properties blob (JSON text). Never parsed by storage. */
  properties: string;
  created_at: number;
  updated_at: number;
  /** LWW clock for structural (parent/position) changes. */
  last_struct_ts: number;
  /** Archival/trash status bitfield (see `@ubimate/types` Document.status). */
  status: number;
  status_timestamp: number | null;
  /** LWW clock for `properties` changes (independent of structural moves). */
  last_properties_ts: number;
  /** SHA-256 hex of the Yjs state vector, or null when no content persisted. */
  yjs_sv_hash: string | null;
}

/** Fields accepted when inserting a document row. */
export interface InsertDocumentInput {
  id: string;
  parent_id: string | null;
  type: DocumentType;
  position: string;
  properties: string;
  created_at: number;
  updated_at: number;
  last_struct_ts: number;
  status: number;
  status_timestamp: number | null;
  last_properties_ts: number;
}

/**
 * Encryption-agnostic, async storage port. `better-sqlite3` is synchronous; a
 * worker/IPC or WASM driver is async — so the contract is async-first and the
 * cloud adapter wraps its synchronous calls in an async signature.
 *
 * Content payloads (`Uint8Array`) are opaque blobs; structural fields are typed
 * metadata. This mirrors the members of the cloud `UserStmts` and the local
 * Rust `db_*` primitives.
 */
export interface StoragePort {
  // Documents ---------------------------------------------------------------
  listDocuments(): Promise<StoredDocument[]>;
  getDocument(id: string): Promise<StoredDocument | null>;
  insertDocument(input: InsertDocumentInput): Promise<void>;
  updateDocument(input: InsertDocumentInput): Promise<void>;
  /** Tombstone (status = deleted) the document and its whole subtree. */
  deleteDocument(id: string, statusTimestamp: number, updatedAt: number): Promise<void>;
  repositionDocument(input: {
    id: string;
    parent_id: string | null;
    position: string;
    updated_at: number;
    last_struct_ts: number;
  }): Promise<void>;
  updateDocumentStatus(input: {
    id: string;
    status: number;
    status_timestamp: number | null;
    updated_at: number;
  }): Promise<void>;
  updateDocumentProperties(input: {
    id: string;
    properties: string;
    updated_at: number;
    last_properties_ts?: number;
  }): Promise<void>;
  ensureDocument(id: string): Promise<void>;
  ensureBlockRegistryDocument(id: string): Promise<void>;

  // Positioning -------------------------------------------------------------
  lastSiblingPosition(parentId: string | null): Promise<string | null>;
  siblingPositionBefore(input: {
    parent_id: string | null;
    before_pos: string;
    exclude_id: string;
  }): Promise<string | null>;

  // Yjs update log (opaque blobs) ------------------------------------------
  getYjsUpdates(documentId: string): Promise<Uint8Array[]>;
  appendYjsUpdate(documentId: string, update: Uint8Array): Promise<void>;
  countYjsUpdates(documentId: string): Promise<number>;
  compactYjsUpdates(
    documentId: string,
    snapshot: Uint8Array,
    yjsSvHash?: string | null,
  ): Promise<void>;
  deleteYjsUpdatesForSubtree(documentId: string): Promise<void>;
  updateYjsSvHash(id: string, yjsSvHash: string | null): Promise<void>;
}
