import { Server, onLoadDocumentPayload, onChangePayload, onAuthenticatePayload, onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import { COMPACT_THRESHOLD } from './db/database';
import { getUserDb } from './db/userDb';
import { JWT_SECRET } from './middleware/auth';
import { broadcastTreeChanged } from './routes/documents';

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
   * The WebSocket server listens on this port independently of Express.
   * Frontend connects via:  new HocuspocusProvider({ url: 'ws://localhost:1234', name: documentId, token: jwtToken })
   */
  port: 1234,

  /**
   * Debounce onChange calls by 1 s (matching notefinity17's behaviour).
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

    const rowCount = userHandle.countYjsUpdates(documentName);
    if (rowCount >= COMPACT_THRESHOLD) {
      const snapshot = Y.encodeStateAsUpdate(document);
      userHandle.compactYjsUpdates(documentName, snapshot);
      console.log(
        `[yjs] Compacted "${documentName}" (${rowCount} rows → 1 snapshot)`
      );
    }
  },

  async onConnect({ documentName, socketId }: onConnectPayload) {
    console.log(`[yjs] Client ${socketId} connected to "${documentName}"`);
  },

  async onDisconnect({ documentName, socketId, document }: onDisconnectPayload) {
    console.log(`[yjs] Client ${socketId} disconnected from "${documentName}"`);
    const DRAWIO_LOCK_TTL = 2 * 60 * 1000;
    const locksMap = document.getMap('drawio-locks') as Y.Map<{ acquiredAt?: number }>;
    locksMap.forEach((val, key) => {
      if (val?.acquiredAt !== undefined && Date.now() - val.acquiredAt > DRAWIO_LOCK_TTL) {
        locksMap.delete(key);
      }
    });
  },
});
