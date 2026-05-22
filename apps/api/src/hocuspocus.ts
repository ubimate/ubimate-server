import { Server, onLoadDocumentPayload, onChangePayload, onAuthenticatePayload, onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { COMPACT_THRESHOLD } from './db/database';
import { getUserDb } from './db/userDb';
import { registryStmts } from './db/registry';
import { JWT_SECRET } from './middleware/auth';
// broadcastTreeChanged is no longer called from hocuspocus — properties
// are pushed by the client via REST PUT, which triggers the broadcast there.

/**
 * Compute the SHA-256 hex digest of a Yjs state vector.
 * Used to fingerprint the CRDT state so the client can skip unchanged
 * documents during sync (hash equality ⇒ identical CRDT state).
 */
function computeYjsSvHash(ydoc: Y.Doc): string {
  const sv = Y.encodeStateVector(ydoc);
  return createHash('sha256').update(sv).digest('hex');
}

// releaseLocksForUser has been removed: the server no longer inspects Yjs
// document content (opaque-backend policy, see docs/OPAQUE-BACKEND.md).
// Block locks are released by client-side TTL expiry instead.

// ---------------------------------------------------------------------------
// Hocuspocus server
//
// Each document is identified by its UUID (document_id in SQLite).
//
// onLoadDocument  – replays all stored Yjs update rows into the fresh Y.Doc,
//                   exactly mirroring the Tauri `get_yjs_updates` flow.
// onChange        – appends the incoming delta to yjs_updates, then compacts
//                   when the row count exceeds COMPACT_THRESHOLD, mirroring
//                   the Tauri `append_yjs_update` / `compact_yjs_updates` flow.
// ---------------------------------------------------------------------------

export const hocuspocus = Server.configure({
  /**
   * No standalone port — Hocuspocus is mounted on the Express HTTP server
   * via handleUpgrade in index.ts.  In development the client connects to
   * ws://localhost:3001/yjs; in production to wss://app.ubimate.com/yjs.
   */

  /**
   * Debounce onChange calls by 1 s (matching ubimate17's behaviour).
   */
  debounce: 1000,

  /**
   * Verify the JWT token sent by the client.
   * Stores userId in context so subsequent hooks can access the right DB.
   */
  async onAuthenticate({ token, context }: onAuthenticatePayload) {
    if (!token) throw new Error('Authentication required');
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };
      // Reject connections from users that don't exist in the registry.
      // This prevents stale JWTs (e.g. from a previous test server) from
      // authenticating against a fresh server instance.
      if (!registryStmts.getUserById.get(payload.sub)) {
        throw new Error('User not found');
      }
      context.userId = payload.sub;
    } catch {
      throw new Error('Invalid or expired token');
    }
  },

  /**
   * Reconstruct in-memory Y.Doc from the user's append-only SQLite update log.
   */
  async onLoadDocument({ document, documentName, context }: onLoadDocumentPayload) {
    const { getYjsUpdates } = getUserDb(context.userId as string);
    const updates = getYjsUpdates(documentName);
    if (updates.length === 0) return;

    for (const update of updates) {
      Y.applyUpdate(document, update);
    }

    console.log(
      `[yjs] Loaded document "${documentName}" from ${updates.length} update(s)`
    );
  },

  /**
   * Persist the incoming delta update to the user's SQLite database.
   *
   * The server is content-agnostic: it does NOT inspect named Yjs maps or
   * fragments (opaque-backend policy, see docs/OPAQUE-BACKEND.md).  Document
   * metadata (title, icon, etc.) is maintained exclusively via the REST API.
   */
  async onChange({ document, documentName, update, context }: onChangePayload) {
    const userHandle = getUserDb(context.userId as string);
    userHandle.appendYjsUpdate(documentName, update);

    const svHash = computeYjsSvHash(document);
    const rowCount = userHandle.countYjsUpdates(documentName);
    if (rowCount >= COMPACT_THRESHOLD) {
      const snapshot = Y.encodeStateAsUpdate(document);
      userHandle.compactYjsUpdates(documentName, snapshot, svHash);
      console.log(
        `[yjs] Compacted "${documentName}" (${rowCount} rows → 1 snapshot)`
      );
    } else {
      // Always update the stored hash so the next sync-check can skip
      // unchanged documents.  Without this, appendYjsUpdate nulls the hash
      // and it only gets restored on compaction — leaving most documents
      // with a null server hash that forces a full sync on every app launch.
      userHandle.stmts.updateYjsSvHash.run({ id: documentName, yjs_sv_hash: svHash });
    }
  },

  async onConnect({ documentName, socketId }: onConnectPayload) {
    console.log(`[yjs] Client ${socketId} connected to "${documentName}"`);
  },

  async onDisconnect({ documentName, socketId }: onDisconnectPayload) {
    console.log(`[yjs] Client ${socketId} disconnected from "${documentName}"`);
    // Block lock release and drawio lock TTL cleanup have been removed:
    // the server no longer reads Yjs document content (opaque-backend policy,
    // see docs/OPAQUE-BACKEND.md). Stale locks expire via client-side TTL.
  },
});
