/**
 * relay.ts — Zero-knowledge opaque Yjs relay.
 *
 * Replaces the Hocuspocus sync server. The Hocuspocus protocol requires the
 * server to maintain a server-side Y.Doc and run the y-protocols sync
 * algorithm, which means it must decode the Yjs update bytes — fundamentally
 * incompatible with end-to-end encryption (see docs/ZK-SYNC-COLLAB.md and the
 * comment in apps/web/src/api/YjsContext.tsx explaining why frame-level
 * encryption of Hocuspocus frames fails).
 *
 * This relay treats every Yjs update as an OPAQUE encrypted blob. It never
 * calls Y.applyUpdate / Y.encodeStateAsUpdate / Y.encodeStateVector. Its only
 * jobs are:
 *   - authenticate the connection (JWT, identical to the old onAuthenticate),
 *   - replay the user's stored encrypted blobs for a document on subscribe,
 *   - persist incoming encrypted blobs (append; client-driven compaction),
 *   - fan out incoming blobs to every other connected client of the same
 *     document so real-time collaboration keeps working.
 *
 * Persistence mirrors the previous per-user model exactly: each user's blobs
 * live in their own SQLite database (getUserDb). The server cannot read them.
 *
 * ---------------------------------------------------------------------------
 * Wire protocol (binary frames, first byte = type)
 *
 *   Client -> Server
 *     0x01 HELLO   : [tokenLen u16 BE][token utf8][docName utf8]
 *     0x02 UPDATE  : [encrypted blob]      append + broadcast
 *     0x03 AWARE   : [encrypted blob]      broadcast only (not stored)
 *     0x04 COMPACT : [encrypted blob]      replace user's stored blobs w/ snapshot
 *
 *   Server -> Client
 *     0x02 UPDATE  : [encrypted blob]
 *     0x03 AWARE   : [encrypted blob]
 *     0x05 SYNCED  : (no payload) sent once after the initial replay completes
 * ---------------------------------------------------------------------------
 */
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { getUserDb } from './db/userDb';
import { registryStmts } from './db/registry';
import { JWT_SECRET } from './middleware/auth';

// Frame type bytes.
const FRAME_HELLO = 0x01;
const FRAME_UPDATE = 0x02;
const FRAME_AWARE = 0x03;
const FRAME_COMPACT = 0x04;
const FRAME_SYNCED = 0x05;

interface RelaySocket {
  ws: WebSocket;
  userId: string;
  documentName: string;
}

/**
 * Rooms keyed by documentName. Membership spans users so that real-time
 * collaboration fans encrypted updates out to every connected client of a
 * document. Persistence remains per-user.
 */
const rooms = new Map<string, Set<RelaySocket>>();

function joinRoom(member: RelaySocket): void {
  let set = rooms.get(member.documentName);
  if (!set) {
    set = new Set();
    rooms.set(member.documentName, set);
  }
  set.add(member);
}

function leaveRoom(member: RelaySocket): void {
  const set = rooms.get(member.documentName);
  if (!set) return;
  set.delete(member);
  if (set.size === 0) rooms.delete(member.documentName);
}

/** Broadcast a framed message to every room member except the sender. */
function broadcast(sender: RelaySocket, frame: Uint8Array): void {
  const set = rooms.get(sender.documentName);
  if (!set) return;
  for (const member of set) {
    if (member === sender) continue;
    if (member.ws.readyState === member.ws.OPEN) {
      member.ws.send(frame);
    }
  }
}

/** Prefix a payload with a 1-byte frame type. */
function frame(type: number, payload?: Uint8Array): Uint8Array {
  if (!payload || payload.length === 0) return Uint8Array.of(type);
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** Coerce a ws message (Buffer | ArrayBuffer | Buffer[]) into a Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Uint8Array) return data;
  throw new Error('Unexpected WebSocket message payload');
}

function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    // Reject connections from users that don't exist in the registry. This
    // prevents stale JWTs (e.g. from a previous test server) from
    // authenticating against a fresh server instance.
    if (!registryStmts.getUserById.get(payload.sub)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Read the HELLO frame: token + documentName. Returns null if malformed. */
function parseHello(payload: Uint8Array): { token: string; documentName: string } | null {
  if (payload.length < 2) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tokenLen = view.getUint16(0, false);
  if (payload.length < 2 + tokenLen) return null;
  const dec = new TextDecoder();
  const token = dec.decode(payload.subarray(2, 2 + tokenLen));
  const documentName = dec.decode(payload.subarray(2 + tokenLen));
  if (!documentName) return null;
  return { token, documentName };
}

export const relay = {
  /**
   * Handle a freshly upgraded WebSocket. Mirrors hocuspocus.handleConnection's
   * call signature so index.ts can swap it in directly.
   */
  handleConnection(ws: WebSocket, request: IncomingMessage): void {
    let member: RelaySocket | null = null;

    ws.on('message', (data) => {
      let bytes: Uint8Array;
      try {
        bytes = toBytes(data);
      } catch {
        return;
      }
      if (bytes.length === 0) return;
      const type = bytes[0];
      const payload = bytes.subarray(1);

      // The first frame must be HELLO (auth + subscribe). Reject everything else.
      if (!member) {
        if (type !== FRAME_HELLO) {
          ws.close(4001, 'auth-required');
          return;
        }
        const hello = parseHello(payload);
        if (!hello) {
          ws.close(4002, 'bad-hello');
          return;
        }
        const userId = verifyToken(hello.token);
        if (!userId) {
          ws.close(4003, 'auth-failed');
          return;
        }
        member = { ws, userId, documentName: hello.documentName };
        joinRoom(member);
        console.log(`[relay] ${userId.slice(0, 8)} subscribed to "${hello.documentName}"`);

        // Replay the user's stored encrypted blobs, then signal SYNCED.
        try {
          const updates = getUserDb(userId).getYjsUpdates(hello.documentName);
          for (const blob of updates) {
            ws.send(frame(FRAME_UPDATE, new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)));
          }
        } catch (err) {
          console.warn(`[relay] replay failed for "${hello.documentName}":`, err);
        }
        ws.send(frame(FRAME_SYNCED));
        return;
      }

      // Authenticated frames.
      switch (type) {
        case FRAME_UPDATE: {
          try {
            getUserDb(member.userId).appendYjsUpdate(member.documentName, payload);
          } catch (err) {
            console.warn(`[relay] append failed for "${member.documentName}":`, err);
          }
          broadcast(member, frame(FRAME_UPDATE, payload));
          break;
        }
        case FRAME_AWARE: {
          broadcast(member, frame(FRAME_AWARE, payload));
          break;
        }
        case FRAME_COMPACT: {
          // Client-driven compaction: replace the user's stored blobs with a
          // single encrypted snapshot. The server cannot merge ciphertext, so
          // compaction must originate from a client that holds the key.
          try {
            getUserDb(member.userId).compactYjsUpdates(member.documentName, payload, null);
          } catch (err) {
            console.warn(`[relay] compact failed for "${member.documentName}":`, err);
          }
          break;
        }
        default:
          // Unknown frame type — ignore.
          break;
      }
    });

    ws.on('close', () => {
      if (member) {
        console.log(`[relay] ${member.userId.slice(0, 8)} left "${member.documentName}"`);
        leaveRoom(member);
        member = null;
      }
    });

    ws.on('error', () => {
      if (member) {
        leaveRoom(member);
        member = null;
      }
    });
  },
};
