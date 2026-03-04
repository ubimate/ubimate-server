import { Server, onLoadDocumentPayload, onChangePayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  appendYjsUpdate,
  compactYjsUpdates,
  countYjsUpdates,
  getYjsUpdates,
  COMPACT_THRESHOLD,
  stmts,
} from './db/database';

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
   * Frontend connects via:  new HocuspocusProvider({ url: 'ws://localhost:1234', name: documentId })
   */
  port: 1234,

  /**
   * Debounce onChange calls by 1 s (matching notefinity17's behaviour).
   * Hocuspocus batches rapid edits and fires onChange once per quiet period.
   */
  debounce: 1000,

  /**
   * Reconstruct in-memory Y.Doc from the append-only SQLite update log.
   */
  async onLoadDocument({ document, documentName }: onLoadDocumentPayload) {
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
   * Persist the incoming delta update to SQLite.
   * Also sync the properties Y.Map back to the documents table (denormalized cache)
   * so REST list/get endpoints always return up-to-date metadata without having to
   * decode the Yjs binary state.
   * Compact the log if the row count exceeds the threshold.
   */
  async onChange({ document, documentName, update }: onChangePayload) {
    appendYjsUpdate(documentName, update);

    // Write-through: extract properties Y.Map and cache in the documents row.
    const propsMap = document.getMap<unknown>('properties');
    if (propsMap.size > 0) {
      const props: Record<string, unknown> = {};
      propsMap.forEach((v, k) => { props[k] = v; });
      stmts.updateDocumentProperties.run({
        id: documentName,
        properties: JSON.stringify(props),
        updated_at: Date.now(),
      });
    }

    const rowCount = countYjsUpdates(documentName);
    if (rowCount >= COMPACT_THRESHOLD) {
      const snapshot = Y.encodeStateAsUpdate(document);
      compactYjsUpdates(documentName, snapshot);
      console.log(
        `[yjs] Compacted "${documentName}" (${rowCount} rows → 1 snapshot)`
      );
    }
  },

  /**
   * Log new connections (useful during development).
   */
  async onConnect({ documentName, socketId }) {
    console.log(`[yjs] Client ${socketId} connected to "${documentName}"`);
  },

  async onDisconnect({ documentName, socketId }) {
    console.log(`[yjs] Client ${socketId} disconnected from "${documentName}"`);
  },
});
