import { Server, onLoadDocumentPayload, onChangePayload, onAuthenticatePayload, onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { COMPACT_THRESHOLD } from './db/database';
import { getUserDb } from './db/userDb';
import { JWT_SECRET } from './middleware/auth';
import { broadcastTreeChanged } from './routes/documents';

/**
 * Compute the SHA-256 hex digest of a Yjs state vector.
 * Used to fingerprint the CRDT state so the client can skip unchanged
 * documents during sync (hash equality ⇒ identical CRDT state).
 */
function computeYjsSvHash(ydoc: Y.Doc): string {
  const sv = Y.encodeStateVector(ydoc);
  return createHash('sha256').update(sv).digest('hex');
}

/** Returns true when documentName is a block-registry document. */
function isBlockRegistryDoc(documentName: string): boolean {
  return documentName.startsWith('block-registry:');
}

/**
 * Walk the y-prosemirror XML fragment and clear every `lockedBy` node
 * attribute that belongs to `userId`.  Called server-side on disconnect so
 * abrupt client exits (CMD-Q, crash, network drop) don't leave blocks locked
 * until the 45-second TTL expires.
 */
function releaseLocksForUser(ydoc: Y.Doc, userId: string): void {
  const fragment = ydoc.getXmlFragment('prosemirror');
  const toRelease: Y.XmlElement[] = [];

  function walk(node: Y.XmlElement | Y.XmlFragment): void {
    if (node instanceof Y.XmlElement) {
      const raw = node.getAttribute('lockedBy');
      if (typeof raw === 'string' && raw) {
        try {
          const lock = JSON.parse(raw) as { userId?: string };
          if (lock?.userId === userId) {
            toRelease.push(node);
          }
        } catch { /* not a valid lock json */ }
      }
    }
    node.toArray().forEach((child) => {
      if (child instanceof Y.XmlElement) walk(child);
    });
  }

  walk(fragment);

  if (toRelease.length > 0) {
    ydoc.transact(() => {
      for (const el of toRelease) {
        el.removeAttribute('lockedBy');
      }
    });
    console.log(
      `[yjs] Released ${toRelease.length} lock(s) for user ${userId} on disconnect`,
    );
  }
}

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
   * ws://localhost:3001/yjs; in production to wss://sovernote.app/yjs.
   */

  /**
   * Debounce onChange calls by 1 s (matching sovernote17's behaviour).
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
   */
  async onChange({ document, documentName, update, context }: onChangePayload) {
    const userHandle = getUserDb(context.userId as string);
    userHandle.appendYjsUpdate(documentName, update);

    // Block-registry documents store Yjs state only — they have no properties
    // column to sync back and do not affect the page tree broadcast.
    // Block content is never inspected server-side (zero-knowledge encryption
    // compatibility): all block-registry writes are handled by the client.
    if (!isBlockRegistryDoc(documentName)) {
      // Write-through: extract properties Y.Map and cache in the documents row.
      const propsMap = document.getMap<unknown>('properties');
      if (propsMap.size > 0) {
        const props: Record<string, unknown> = {};
        propsMap.forEach((v, k) => { props[k] = v; });
        userHandle.stmts.updateDocumentProperties.run({
          id: documentName,
          properties: JSON.stringify(props),
          updated_at: Date.now(),
        });
        broadcastTreeChanged(context.userId as string);
      }
    }

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

  async onDisconnect({ documentName, socketId, document, context }: onDisconnectPayload) {
    console.log(`[yjs] Client ${socketId} disconnected from "${documentName}"`);

    // Release any block locks held by the disconnecting user inside the
    // ProseMirror XML fragment.  This fires for every disconnect (normal
    // tab-close, CMD-Q, crash, network drop) so abrupt quits are covered
    // even when the client never gets a chance to send an unlock update.
    const userId = (context as { userId?: string })?.userId;
    if (userId) {
      releaseLocksForUser(document, userId);
    }

    // Legacy: clean up expired entries in the drawio-locks Yjs Map.
    const DRAWIO_LOCK_TTL = 2 * 60 * 1000;
    const locksMap = document.getMap('drawio-locks') as Y.Map<{ acquiredAt?: number }>;
    locksMap.forEach((val, key) => {
      if (val?.acquiredAt !== undefined && Date.now() - val.acquiredAt > DRAWIO_LOCK_TTL) {
        locksMap.delete(key);
      }
    });
  },
});
