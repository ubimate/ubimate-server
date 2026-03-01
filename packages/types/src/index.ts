// ---------------------------------------------------------------------------
// Shared domain types — used by both apps/api and apps/web.
// This is the single source of truth for the Notefinity data model.
// ---------------------------------------------------------------------------

export type DocumentType = 'page' | 'folder' | 'workspace';

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
 */
export interface RepositionDocumentPayload {
  parent_id: string | null;
  before_id: string | null;
}

/** Payload for PUT /api/documents/:id — all fields optional (partial update). */
export interface UpdateDocumentPayload {
  parent_id?: string | null;
  type?: DocumentType;
  position?: string;
  properties?: Record<string, unknown>;
}
