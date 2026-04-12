// ---------------------------------------------------------------------------
// Shared domain types — used by both apps/api and apps/web.
// This is the single source of truth for the Sovernote data model.
// ---------------------------------------------------------------------------

export type DocumentType = 'page' | 'db-page' | 'folder' | 'db-folder' | 'workspace' | 'image' | 'file' | 'block-registry';

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
  /**
   * Archival/trash status bitfield.
   *   0 = active (normal)
   *   1 = archived
   *   2 = trashed
   *   3 = archived-and-trashed
   * Bit 0 (0x1) = archived; Bit 1 (0x2) = trashed.
   */
  status: number;
  /** Unix epoch seconds; null when the document has never left the active state. */
  status_timestamp: number | null;
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
  /**
   * When provided by the sync layer, the server uses this fractional-index
   * string directly instead of computing a new one from `before_id`.
   * This preserves exact ordering across devices during reconnect sync.
   */
  position?: string;
}

// ---------------------------------------------------------------------------
// Structural-sync — used by the Tauri local app when replaying an offline queue
// ---------------------------------------------------------------------------

/** Identifies which kind of structural mutation an offline op represents. */
export type StructOpKind = 'reposition' | 'create' | 'delete' | 'update_properties' | 'update_status';

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
   *   update_status     → { status: number } (LWW-guarded by status_timestamp)
   */
  payload: RepositionDocumentPayload | CreateDocumentPayload | UpdateDocumentPayload | { status: number } | Record<string, never>;
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** A registered user as returned by the API (no password fields). */
export interface User {
  id: string;
  email: string;
  /** Extensible user properties (name, avatar, etc.). Will be encrypted at rest in future. */
  properties: Record<string, unknown>;
  created_at: number; // Unix ms
}

// ---------------------------------------------------------------------------
// Block Registry — workspace-wide block metadata (Yjs-backed, always open)
// ---------------------------------------------------------------------------

/**
 * One entry per labelled block instance in the workspace.
 * Stored in the block-registry Y.Doc under the `blocks` Y.Map (key = blockId).
 */
export interface BlockRegistryEntry {
  /** ID of the page document that contains this block. */
  documentId: string;
  /** Human-readable label (e.g. YAML `label`, tag name). */
  label: string;
  /** Block type discriminator, e.g. "datatable" | "smart-tag" | "chart". */
  type: string;
  /** Smart-tag instance value (omitted for non-tag blocks). */
  value?: string;
  /** Task checked state — true when done (only for type === "task"). */
  checked?: boolean;
  /** 0-based position of the task within its page (document order). Used for sidebar sorting. */
  order?: number;
  /** Indentation level of the task (mirrors flatListItem indent attr). Used for sidebar nesting. */
  indent?: number;
  /** Datatable column names (schema), published so other datatables can build pickers. */
  columns?: string[];
  /** Datatable column definitions with types, used for ER diagram rendering. */
  columnDefs?: Array<{ name: string; type: string }>;
  /** Datatable relation targets (omitted for non-datatable blocks). */
  relations?: Array<{
    column: string;
    targetBlockId: string;
    type?: 'one-to-one' | 'one-to-many' | 'many-to-one';
    /** Columns of the target datatable this block needs for relation chips / row-picker. */
    projectedColumns: string[];
  }>;
  /**
   * Datatable row projection for relation resolution.
   * Owned by the TARGET block; its `columns` is the union of all consumers'
   * `projectedColumns` declarations.
   */
  projection?: {
    /** Union of all consumers' declared column needs. */
    columns: string[];
    /** rowId → { columnName → value } restricted to `columns`. */
    rows: Record<string, Record<string, string>>;
  };
  /** Surrounding prose text snippet for date/datetime entries (calendar sidebar display). */
  excerpt?: string;
  /** IDs of tagMention nodes that appear in the same block as a date/datetime mention. */
  contextTagIds?: string[];
  // ── Media fields (type === 'image' | 'file' | 'audio') ──────────────────
  /** URL/path of the media asset. */
  mediaSrc?: string;
  /** Alt text — image blocks only. */
  mediaAlt?: string;
  /** Caption — image and audio blocks. */
  mediaCaption?: string;
  /** Original filename — file blocks only. */
  mediaFilename?: string;
  /** MIME type — file blocks only. */
  mediaMimeType?: string;
  /** File size in bytes — file blocks only. */
  mediaFileSize?: number;
  /** Unix ms timestamp at last write. */
  updatedAt: number;
}

/**
 * Workspace-level schema for a smart tag.
 * Stored in the block-registry Y.Doc under the `tagDefs` Y.Map (key = tag name).
 */
export interface TagDefinition {
  valueType: 'string' | 'number' | 'date' | 'boolean' | 'select';
  /** Valid options — only present when `valueType` is "select". */
  options?: string[];
  /** Color palette name assigned at tag creation (e.g. "blue", "green"). */
  color?: string;
  /** Unix ms timestamp at last write. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Body of POST /api/auth/login */
export interface AuthPayload {
  email: string;
  password: string;
}

/** Response of POST /api/auth/register and POST /api/auth/login */
export interface AuthResponse {
  user: User;
}
