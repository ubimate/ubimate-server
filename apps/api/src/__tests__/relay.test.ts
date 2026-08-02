// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for the zero-knowledge Yjs relay wire protocol — the parts that keep
 * sync honest over a flaky network: blob replay on (re)connect and the
 * application-level PING/PONG keepalive clients use to spot a half-open socket.
 */

import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';

const FRAME_HELLO = 0x01;
const FRAME_UPDATE = 0x02;
const FRAME_COMPACT = 0x04;
const FRAME_SYNCED = 0x05;
const FRAME_PING = 0x06;
const FRAME_PONG = 0x07;

const TEST_USER_ID = 'test-user-relay';
const DOC_NAME = 'doc-under-test';

/** Build a HELLO payload: [tokenLen u16 BE][token][docName]. */
function helloFrame(token: string, documentName: string): Uint8Array {
  const enc = new TextEncoder();
  const tokenBytes = enc.encode(token);
  const nameBytes = enc.encode(documentName);
  const payload = new Uint8Array(2 + tokenBytes.length + nameBytes.length);
  new DataView(payload.buffer).setUint16(0, tokenBytes.length, false);
  payload.set(tokenBytes, 2);
  payload.set(nameBytes, 2 + tokenBytes.length);
  const out = new Uint8Array(1 + payload.length);
  out[0] = FRAME_HELLO;
  out.set(payload, 1);
  return out;
}

function frame(type: number, payload?: Uint8Array): Uint8Array {
  if (!payload || payload.length === 0) return Uint8Array.of(type);
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

describe('yjs relay', () => {
  let tmpDir: string;
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let wsUrl = '';
  let token = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-relay-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'relay-test-secret';

    // The registry DB is a module singleton that afterEach closes — reset the
    // module registry so each test opens a fresh one against its own DATA_DIR.
    vi.resetModules();

    const { registryStmts } = await import('../db/registry');
    registryStmts.createUser.run({
      id: TEST_USER_ID,
      email: 'relay@test.local',
      properties: '{}',
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'user',
    });

    const jwt = (await import('jsonwebtoken')).default;
    token = jwt.sign({ sub: TEST_USER_ID }, process.env.JWT_SECRET);

    const { relay } = await import('../relay');
    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      wss!.handleUpgrade(request, socket, head, (ws) => {
        relay.handleConnection(ws, request);
      });
    });
    server.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/yjs`;
  });

  afterEach(async () => {
    wss?.close();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    const { closeRegistryDb } = await import('../db/registry');
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Connect, send HELLO, and collect frames until SYNCED arrives. */
  async function connectAndSync(): Promise<{ ws: WebSocket; replayed: Uint8Array[] }> {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const replayed: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send(helloFrame(token, DOC_NAME)));
      ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        if (bytes[0] === FRAME_UPDATE) replayed.push(bytes.subarray(1));
        else if (bytes[0] === FRAME_SYNCED) resolve();
      });
    });
    return { ws, replayed };
  }

  it('replays stored blobs and signals SYNCED on reconnect', async () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5]);

    const first = await connectAndSync();
    expect(first.replayed).toHaveLength(0);
    first.ws.send(frame(FRAME_UPDATE, blob));
    // Let the append hit SQLite before dropping the socket.
    await new Promise((r) => setTimeout(r, 100));
    first.ws.close();

    const second = await connectAndSync();
    expect(second.replayed).toHaveLength(1);
    expect(Array.from(second.replayed[0])).toEqual(Array.from(blob));
    second.ws.close();
  });

  it('answers PING with PONG so clients can detect a half-open socket', async () => {
    const { ws } = await connectAndSync();

    const pong = new Promise<number>((resolve) => {
      ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        resolve(bytes[0]);
      });
    });
    ws.send(frame(FRAME_PING));

    expect(await pong).toBe(FRAME_PONG);
    ws.close();
  });

  it('fans an update out to the other clients of the document', async () => {
    const a = await connectAndSync();
    const b = await connectAndSync();

    const blob = new Uint8Array([9, 8, 7]);
    const received = new Promise<Uint8Array>((resolve) => {
      b.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        if (bytes[0] === FRAME_UPDATE) resolve(bytes.subarray(1));
      });
    });
    a.ws.send(frame(FRAME_UPDATE, blob));

    expect(Array.from(await received)).toEqual(Array.from(blob));
    // The sender must not receive its own frame back.
    expect(a.replayed).toHaveLength(0);

    a.ws.close();
    b.ws.close();
  });

  it('COMPACT replaces the stored blobs with the snapshot', async () => {
    const first = await connectAndSync();
    first.ws.send(frame(FRAME_UPDATE, new Uint8Array([1])));
    first.ws.send(frame(FRAME_UPDATE, new Uint8Array([2])));
    await new Promise((r) => setTimeout(r, 100));
    first.ws.close();

    const second = await connectAndSync();
    expect(second.replayed).toHaveLength(2);
    second.ws.send(frame(FRAME_COMPACT, new Uint8Array([1, 2])));
    await new Promise((r) => setTimeout(r, 100));
    second.ws.close();

    const third = await connectAndSync();
    expect(third.replayed).toHaveLength(1);
    expect(Array.from(third.replayed[0])).toEqual([1, 2]);
    third.ws.close();
  });

  it('rejects a PING sent before HELLO', async () => {
    const ws = new WebSocket(wsUrl);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send(frame(FRAME_PING)));
      ws.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4001);
  });
});
