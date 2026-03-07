// ---------------------------------------------------------------------------
// Shared domain types — used by both apps/api and apps/web.
// This is the single source of truth for the Notefinity data model.
// ---------------------------------------------------------------------------

export type DocumentType = 'page' | 'folder' | 'workspace' | 'image';

/**
 * A document as returned by the REST API (properties already parsed from JSON).
 * This is the canonical shape shared between the server and all clients.
 */
export interface Document {
  id: string;
  parent_id: string | null;
  type: DocumentType;
  /** Fractional-index string used for stable ordering within a parent. */
  position: string;
  properties: Record<string, unknown>;
  created_at: number; // Unix ms
  updated_at: number; // Unix ms
}

/** Payload for POST /api/documents */
export interface CreateDocumentPayload {
  parent_id?: string | null;
  type: DocumentType;
  position?: string;
  properties?: Record<string, unknown>;
}

/**
 * Payload for PATCH /api/documents/:id/reposition
 * Moves the document under `parent_id`, placing it immediately before `before_id`.
 * Pass `before_id: null` to append at the end of the sibling list.
 *
 * `client_ts` is the Unix-ms timestamp from the client's local clock at the moment
 * the user performed the drag. When present the server applies last-write-wins (LWW):
 * if a newer structural operation has already been recorded for this document the
 * incoming reposition is silently skipped so that, during an offline-sync replay,
 * whichever app acted most recently always wins without any manual conflict resolution.
 */
export interface RepositionDocumentPayload {
  parent_id: string | null;
  before_id: string | null;
  /** Unix ms — client clock at the time of the operation. Enables LWW sync semantics. */
  client_ts?: number;
}

// ---------------------------------------------------------------------------
// Structural-sync — used by the Tauri local app when replaying an offline queue
// ---------------------------------------------------------------------------

/** Identifies which kind of structural mutation an offline op represents. */
export type StructOpKind = 'reposition' | 'create' | 'delete' | 'update_properties';

/**
 * A single structural operation recorded by a local app while offline.
 * Batches of these are replayed against the cloud node via POST /api/sync/structural.
 */
export interface StructOp {
  op: StructOpKind;
  /** The document this operation targets. */
  id: string;
  /**
   * Unix ms from the client's local clock at the time the user performed the action.
   * Operations are applied in ascending `client_ts` order; within the same document,
   * only the operation with the highest `client_ts` wins (last-write-wins).
   */
  client_ts: number;
  /**
   * Operation-specific payload:
   *   reposition        → RepositionDocumentPayload (without client_ts — it's on the op)
   *   create            → CreateDocumentPayload
   *   delete            → {} (empty object)
   *   update_properties → { properties: Record<string, unknown> }
   */
  payload: RepositionDocumentPayload | CreateDocumentPayload | UpdateDocumentPayload | Record<string, never>;
}

/** Body of POST /api/sync/structural */
export interface SyncStructuralPayload {
  ops: StructOp[];
}

/** Response of POST /api/sync/structural */
export interface SyncStructuralResult {
  /** Number of ops that were applied. */
  applied: number;
  /** Number of ops that were skipped because a newer op had already been applied. */
  skipped: number;
  /** Full canonical document list after all ops have been processed. */
  documents: Document[];
}

/** Payload for PUT /api/documents/:id — all fields optional (partial update). */
export interface UpdateDocumentPayload {
  parent_id?: string | null;
  type?: DocumentType;
  position?: string;
  properties?: Record<string, unknown>;
}
