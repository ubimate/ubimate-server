// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * A client's sync reads a document's blobs, merges them with its own and writes back a blob, a hash,
 * or both. Content another device stores in between is content that client did not see:
 *
 * - a replacing snapshot (`replace: true`, the sync's compaction) would delete it from the server;
 * - a hash would vouch for the client's state as the stored one, and a device holding that hash
 *   would skip the document and never fetch the other edit.
 *
 * `GET /:id/yjs` returns the content's `version`, and the client hands it back as `seen`: a stale
 * replace is refused, a stale append keeps no hash, and a hash-only stamp (`PUT /:id/yjs-hash`, for
 * a merge that found nothing to add) records nothing.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';

const TEST_USER_ID = 'test-user-yjs-versioning';
const DOC = 'doc-1';
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

describe('Yjs content versioning (seen / version)', () => {
  let tmpDir: string;
  let handle: UserDbHandle;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-yjs-version-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
    handle = initUserDb(path.join(tmpDir, 'users', `${TEST_USER_ID}.db`));

    vi.resetModules();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = TEST_USER_ID;
        (req as Request & { userDbHandle: UserDbHandle }).userDbHandle = handle;
        next();
      },
    }));
    const { documentsRouter } = await import('../routes/documents');
    const app = express();
    app.use(express.json());
    app.use('/api/documents', documentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    handle.db.close();
    vi.doUnmock('../middleware/auth');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function read(): Promise<{ updates: string[]; version: number }> {
    const res = await fetch(`${baseUrl}/api/documents/${DOC}/yjs`);
    expect(res.status).toBe(200);
    return (await res.json()) as { updates: string[]; version: number };
  }

  function store(body: Record<string, unknown>): Promise<globalThis.Response> {
    return fetch(`${baseUrl}/api/documents/${DOC}/yjs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function stamp(body: Record<string, unknown>): Promise<globalThis.Response> {
    return fetch(`${baseUrl}/api/documents/${DOC}/yjs-hash`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Another device's write landing between this client's read and its write: the live relay's path. */
  const anotherDeviceAppends = () => handle.appendYjsUpdate(DOC, new Uint8Array([9, 9, 9]));
  const storedHash = () => (handle.stmts.getDocument.get(DOC) as { yjs_sv_hash: string | null }).yjs_sv_hash;

  it('reads version 0 for no content, and every write moves it forward', async () => {
    expect((await read()).version).toBe(0);
    await store({ update: b64([1]) });
    const first = (await read()).version;
    await store({ update: b64([2]) });
    const second = (await read()).version;
    await store({ update: b64([3]), replace: true });
    const third = (await read()).version;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('refuses a replacing snapshot over content stored since the read, and keeps that content', async () => {
    await store({ update: b64([1]) });
    const { version } = await read();
    anotherDeviceAppends();

    const res = await store({ update: b64([1, 2]), replace: true, yjs_sv_hash: 'mine', seen: version });

    expect(res.status).toBe(409);
    expect((await read()).updates).toEqual([b64([1]), b64([9, 9, 9])]);
  });

  it('keeps an append over content stored since the read, but not its hash', async () => {
    await store({ update: b64([1]) });
    const { version } = await read();
    anotherDeviceAppends();

    const res = await store({ update: b64([2]), yjs_sv_hash: 'mine', seen: version });

    expect(res.status).toBe(204);
    expect((await read()).updates).toEqual([b64([1]), b64([9, 9, 9]), b64([2])]);
    expect(storedHash()).toBeNull();
  });

  it('stores the hash with a write made over what it read', async () => {
    await store({ update: b64([1]) });
    const { version } = await read();

    expect((await store({ update: b64([2]), yjs_sv_hash: 'mine', seen: version })).status).toBe(204);
    expect(storedHash()).toBe('mine');
    const again = await read();
    expect((await store({ update: b64([3]), replace: true, yjs_sv_hash: 'compacted', seen: again.version })).status).toBe(204);
    expect((await read()).updates).toEqual([b64([3])]);
    expect(storedHash()).toBe('compacted');
  });

  it('stamps a hash for the content it read, and nothing once content was stored since', async () => {
    await store({ update: b64([1]) }); // as the relay stores: no hash
    expect(storedHash()).toBeNull();
    const { version } = await read();

    const ok = await stamp({ yjs_sv_hash: 'merged', seen: version });
    expect(await ok.json()).toEqual({ stamped: true });
    expect(storedHash()).toBe('merged');

    anotherDeviceAppends(); // clears it, as any new content does
    const late = await stamp({ yjs_sv_hash: 'merged', seen: version });
    expect(await late.json()).toEqual({ stamped: false });
    expect(storedHash()).toBeNull();
  });

  it('stores as before for a client that sends no version', async () => {
    await store({ update: b64([1]) });
    anotherDeviceAppends();
    expect((await store({ update: b64([5]), replace: true, yjs_sv_hash: 'old-client' })).status).toBe(204);
    expect(storedHash()).toBe('old-client');
  });
});
