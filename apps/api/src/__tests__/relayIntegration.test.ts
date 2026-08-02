// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * End-to-end sync test: the real CloudRelayProvider talking to the real relay
 * over a real WebSocket, with real SQLite persistence behind it.
 *
 * The provider's own unit tests (apps/web/src/__tests__/cloudRelayProvider.test.ts)
 * drive a mock socket, so they cannot catch a wire-format disagreement between
 * the two halves — this one can. It is also the only place where "the edit
 * survived a broken connection" is asserted against what the server actually
 * stored, rather than against what the client believes it sent.
 *
 * The provider is imported across the app boundary on purpose: both halves of
 * the protocol have to run in one process for the test to mean anything. It
 * runs unencrypted (the demo-workspace path) so stored blobs are readable Yjs
 * bytes; the encryption layer is covered by the e2e encryption specs.
 */

import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import * as Y from 'yjs';
import { CloudRelayProvider } from '../../../web/src/api/CloudRelayProvider';

const TEST_USER_ID = 'test-user-relay-integration';
const DOC_NAME = 'integration-doc';

/** Wait for a condition, polling — the round trip spans two event loops. */
async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('relay ↔ CloudRelayProvider (real socket)', () => {
  let tmpDir: string;
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let wsUrl = '';
  let token = '';
  let getStoredUpdates: () => Uint8Array[];
  const providers: CloudRelayProvider[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-relay-int-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'relay-integration-secret';

    vi.resetModules();

    const { registryStmts } = await import('../db/registry');
    registryStmts.createUser.run({
      id: TEST_USER_ID,
      email: 'relay-int@test.local',
      properties: '{}',
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'user',
    });

    const jwt = (await import('jsonwebtoken')).default;
    token = jwt.sign({ sub: TEST_USER_ID }, process.env.JWT_SECRET);

    const { getUserDb } = await import('../db/userDb');
    getStoredUpdates = () =>
      getUserDb(TEST_USER_ID)
        .getYjsUpdates(DOC_NAME)
        .map((b) => new Uint8Array(b));

    const { relay } = await import('../relay');
    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      wss!.handleUpgrade(request, socket, head, (ws) => relay.handleConnection(ws, request));
    });
    server.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/yjs`;

    // The provider is browser code: it calls `new WebSocket(url)`. Node 24 has
    // a global WebSocket, but pin it to `ws` so the test does not depend on the
    // runtime's implementation.
    vi.stubGlobal('WebSocket', WsWebSocket);
  });

  afterEach(async () => {
    for (const p of providers.splice(0)) p.destroy();
    vi.unstubAllGlobals();
    wss?.close();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    const { closeRegistryDb } = await import('../db/registry');
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function connect(doc: Y.Doc): CloudRelayProvider {
    const provider = new CloudRelayProvider({
      url: wsUrl,
      name: DOC_NAME,
      document: doc,
      token: () => token,
      getKey: () => null,
      encrypted: false,
    });
    providers.push(provider);
    return provider;
  }

  /** Merge everything the server has stored for this doc. */
  function storedDoc(): Y.Doc {
    const merged = new Y.Doc();
    for (const update of getStoredUpdates()) Y.applyUpdate(merged, update);
    return merged;
  }

  it('persists live edits through the real wire protocol', async () => {
    const doc = new Y.Doc();
    const provider = connect(doc);
    await until(() => provider.isSynced);

    doc.getText('body').insert(0, 'hello over the wire');
    await until(() => storedDoc().getText('body').toString() === 'hello over the wire');
  });

  it('pushes edits made before the socket ever connected', async () => {
    // Stands in for edits made while offline: they exist only in the Y.Doc, and
    // no 'update' event will fire for them again.
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'written offline');

    const provider = connect(doc);
    await until(() => provider.isSynced);
    await until(() => storedDoc().getText('body').toString() === 'written offline');
  });

  it('recovers an edit the server never stored, after a reconnect', async () => {
    const doc = new Y.Doc();
    const provider = connect(doc);
    await until(() => provider.isSynced);

    doc.getText('body').insert(0, 'first');
    await until(() => storedDoc().getText('body').toString() === 'first');

    // Sever the connection at the socket level and make an edit that has
    // nowhere to go — the frame is written to a socket the server already
    // dropped, exactly like a half-open connection.
    for (const client of wss!.clients) client.terminate();
    doc.getText('body').insert(5, ' and lost');
    await new Promise((r) => setTimeout(r, 150));
    expect(storedDoc().getText('body').toString()).toBe('first');

    // The provider reconnects on its own backoff timer and resyncs the gap.
    await until(() => provider.isSynced, 8_000);
    await until(
      () => storedDoc().getText('body').toString() === 'first and lost',
      8_000,
    );
  }, 20_000);

  it('converges two clients editing the same document', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = connect(docA);
    const b = connect(docB);
    await until(() => a.isSynced && b.isSynced);

    docA.getText('body').insert(0, 'from A');
    await until(() => docB.getText('body').toString() === 'from A');

    docB.getText('body').insert(6, ' + from B');
    await until(() => docA.getText('body').toString() === 'from A + from B');
    await until(() => storedDoc().getText('body').toString() === 'from A + from B');
  });
});
