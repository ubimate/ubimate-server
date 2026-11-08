// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * /api/attachments in local mode (docs/ATTACHMENT-ENCRYPTION.md 6): presign, PUT, confirm, resolve, read,
 * list and delete, with the quota and Space membership each of them depends on. The bytes and wrapped
 * keys come from the real format 2 encryptor in @ubimate/crypto.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOB_OVERHEAD, WRAPPED_KEY_BYTES, decryptBlob, encryptBlob, generateAttachmentKey, generateContentKey,
  unwrapAttachmentKey, wrapAttachmentKey, _sodium,
} from '@ubimate/crypto';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';
const WS = 'ws-1';
const KB = 1024;

describe('attachments router (local mode)', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let port = 0;
  let registry: typeof import('../db/registry');
  let quota: typeof import('../lib/quota');
  let lib: typeof import('../lib/attachments');
  let currentUser = ALICE;
  let spaceKey: Uint8Array;

  function addUser(id: string, limit: number | null = null): void {
    registry.registryStmts.createUser.run({
      id, email: `${id}@example.com`,
      properties: JSON.stringify(limit === null ? {} : { service: { diskQuotaBytes: limit } }),
      created_at: Date.now(), status: 'active', public_key: null, wrapped_content_key: null, user_type: 'free',
    });
  }
  const addMember = (userId: string, workspaceId = WS): void => {
    registry.registryStmts.insertWorkspaceKey.run({ workspace_id: workspaceId, user_id: userId, wrapped_key: 'sealed', granted_at: 1 });
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-attachments-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.UPLOAD_MAX_SIZE_MB = '1';
    process.env.MAX_IMAGE_UPLOAD_MB = '1';
    process.env.MAX_AUDIO_UPLOAD_MB = '2';
    process.env.MAX_VIDEO_UPLOAD_MB = '3';
    currentUser = ALICE;
    spaceKey = await generateContentKey();

    vi.resetModules();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = currentUser;
        next();
      },
    }));

    registry = await import('../db/registry');
    quota = await import('../lib/quota');
    lib = await import('../lib/attachments');
    addUser(ALICE);
    addUser(BOB);
    addUser(CAROL);
    const { attachmentsRouter } = await import('../routes/attachments');
    const app = express();
    app.use(express.json());
    app.use('/api/attachments', attachmentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
      server = null;
    }
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'NODE_ENV', 'UPLOAD_MAX_SIZE_MB', 'MAX_IMAGE_UPLOAD_MB', 'MAX_AUDIO_UPLOAD_MB', 'MAX_VIDEO_UPLOAD_MB']) delete process.env[k];
    vi.resetModules();
  });

  // --- helpers --------------------------------------------------------------------------------

  let counter = 0;
  const newId = (): string => `att-${++counter}-${Math.random().toString(16).slice(2, 10)}`;

  /** A real blob and wrapped key for `plaintext`, as the format 2 uploader makes them. */
  async function makeBlob(attachmentId: string, plaintext: Uint8Array, keyVersion = 1) {
    const a = await generateAttachmentKey();
    const blob = await encryptBlob(plaintext, a, attachmentId);
    const wrappedKey = await wrapAttachmentKey(a, spaceKey, { workspaceId: WS, attachmentId, keyVersion });
    return { a, blob, wrappedKey };
  }

  const bodyOf = (attachmentId: string, wrappedKey: string, size: number, extra: Record<string, unknown> = {}) => ({
    workspaceId: WS, attachmentId, size, kind: 'file', keyVersion: 1, wrappedKey, ...extra,
  });

  const json = (method: string, url: string, body?: unknown): Promise<globalThis.Response> =>
    fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  const presign = (body: Record<string, unknown>) => json('POST', '/api/attachments/presign', body);
  const put = (id: string, bytes: Uint8Array) => fetch(`${baseUrl}/api/attachments/${id}/content`, { method: 'PUT', body: bytes as BodyInit });
  const confirm = (id: string) => json('POST', `/api/attachments/${id}/confirm`);
  const resolve = (ids: string[]) => json('POST', '/api/attachments/resolve', { ids });

  /** A PUT with no Content-Length, sent in pieces, so a body can be shorter or longer than declared. */
  function putChunked(id: string, chunks: Uint8Array[]): Promise<{ status: number; body: string }> {
    return new Promise((resolveReq, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'PUT', path: `/api/attachments/${id}/content`,
        headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/octet-stream' },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      for (const c of chunks) req.write(c);
      req.end();
    });
  }

  /** The whole upload: presign, PUT, confirm. Returns what a resolver would need. */
  async function upload(plaintext: Uint8Array, id = newId(), opts: { user?: string } = {}) {
    const before = currentUser;
    if (opts.user) currentUser = opts.user;
    const { a, blob, wrappedKey } = await makeBlob(id, plaintext);
    const p = await presign(bodyOf(id, wrappedKey, blob.length));
    expect(p.status).toBe(200);
    expect((await put(id, blob)).status).toBe(204);
    expect((await confirm(id)).status).toBe(200);
    currentUser = before;
    return { id, a, blob, wrappedKey };
  }

  const rowOf = (id: string) => registry.registryStmts.getAttachment.get(id) as import('../db/registry').AttachmentRow | undefined;
  const usedOf = (userId: string): number => quota.attachmentsUsed(userId);
  const fileOf = (userId: string, id: string): string => path.join(tmpDir, 'uploads', userId, id);
  const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

  // --- constants the server cannot import ----------------------------------------------------------

  it('uses the same blob overhead and wrapped-key length as the encryptor', () => {
    expect(lib.BLOB_OVERHEAD_BYTES).toBe(BLOB_OVERHEAD);
    expect(lib.WRAPPED_KEY_CHARS).toBe(_sodium.to_base64(new Uint8Array(WRAPPED_KEY_BYTES)).length);
  });

  it('serves nothing under /uploads and keeps no route for the old upload endpoints', () => {
    const index = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    expect(index).not.toMatch(/['"`]\/uploads['"`/]/);
    expect(index).not.toContain('/api/uploads');
    expect(fs.existsSync(path.join(__dirname, '../routes/uploads.ts'))).toBe(false);
  });

  // --- presign --------------------------------------------------------------------------------

  describe('POST /presign', () => {
    it('answers with a local upload URL, the headers to send, and records a pending row', async () => {
      const id = newId();
      const { blob, wrappedKey } = await makeBlob(id, bytes(100));
      const res = await presign(bodyOf(id, wrappedKey, blob.length));
      expect(res.status).toBe(200);
      const body = await res.json() as { mode: string; uploadUrl: string; headers: Record<string, string>; expiresAt: number };
      expect(body.mode).toBe('local');
      expect(body.uploadUrl).toBe(`/api/attachments/${id}/content`);
      expect(body.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.length) });
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(rowOf(id)).toMatchObject({
        status: 'pending', uploader_user_id: ALICE, owner_user_id: ALICE, workspace_id: WS, kind: 'file', storage: 'local',
        key_version: 1, wrapped_key: wrappedKey, expected_size: blob.length, size_bytes: null,
      });
      expect(usedOf(ALICE)).toBe(0);
    });

    it('rejects a body with any field missing or malformed', async () => {
      const id = newId();
      const { blob, wrappedKey } = await makeBlob(id, bytes(10));
      const good = bodyOf(id, wrappedKey, blob.length);
      const bad: Record<string, unknown>[] = [
        { workspaceId: '' }, { workspaceId: 'a/b' }, { workspaceId: 5 },
        { attachmentId: '../x' }, { attachmentId: 'a b' }, { attachmentId: undefined },
        { size: 40 }, { size: 1.5 }, { size: '100' }, { size: -1 },
        { kind: 'document' }, { kind: undefined },
        { keyVersion: 0 }, { keyVersion: 1.5 }, { keyVersion: '1' },
        { wrappedKey: 'short' }, { wrappedKey: `${wrappedKey}=` }, { wrappedKey: wrappedKey.slice(1) }, { wrappedKey: 'a+b/'.repeat(24) },
      ];
      for (const patch of bad) {
        const res = await presign({ ...good, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      expect(rowOf(id)).toBeUndefined();
    });

    it('refuses a Space that has members and the caller is not one, and records nothing', async () => {
      addMember(BOB);
      const id = newId();
      const { blob, wrappedKey } = await makeBlob(id, bytes(10));
      expect((await presign(bodyOf(id, wrappedKey, blob.length))).status).toBe(403);
      expect(rowOf(id)).toBeUndefined();
    });

    it('accepts a member, and a Space nobody has a key for yet', async () => {
      addMember(ALICE);
      const a = newId();
      const ma = await makeBlob(a, bytes(10));
      expect((await presign(bodyOf(a, ma.wrappedKey, ma.blob.length))).status).toBe(200);

      const b = newId();
      const mb = await makeBlob(b, bytes(10));
      expect((await presign(bodyOf(b, mb.wrappedKey, mb.blob.length, { workspaceId: 'ws-new' }))).status).toBe(200);
      expect(rowOf(b)?.workspace_id).toBe('ws-new');
    });

    it('refuses a stale key version with the current one, and records nothing', async () => {
      const id = newId();
      const { blob, wrappedKey } = await makeBlob(id, bytes(10), 2);
      const res = await presign(bodyOf(id, wrappedKey, blob.length, { keyVersion: 2 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'key_rotated', currentVersion: 1 });
      expect(rowOf(id)).toBeUndefined();
      expect(quota.remainingBytes(ALICE, 1_000_000)).toBe(1_000_000);
    });

    it('applies the cap of the kind to the ciphertext, the blob overhead on top of the plaintext cap', async () => {
      const cap = 1024 * 1024;
      const id = newId();
      const { wrappedKey } = await makeBlob(id, bytes(1));
      // The image cap is 1 MB here: a file of exactly that fits, one byte more does not.
      expect((await presign(bodyOf(id, wrappedKey, cap + lib.BLOB_OVERHEAD_BYTES, { kind: 'image' }))).status).toBe(200);
      const over = await presign(bodyOf(newId(), wrappedKey, cap + lib.BLOB_OVERHEAD_BYTES + 1, { kind: 'image' }));
      expect(over.status).toBe(400);
      expect(((await over.json()) as { error: string }).error).toMatch(/Maximum size is 1 MB/);
      // Audio and video have their own, larger caps.
      expect((await presign(bodyOf(newId(), wrappedKey, 2 * cap, { kind: 'audio' }))).status).toBe(200);
      expect((await presign(bodyOf(newId(), wrappedKey, 2 * cap, { kind: 'video' }))).status).toBe(200);
      expect((await presign(bodyOf(newId(), wrappedKey, 2 * cap, { kind: 'file' }))).status).toBe(400);
    });

    it('reserves the bytes against the quota, so a second upload that does not fit is refused with the 413', async () => {
      addUser('limited', 10 * KB);
      currentUser = 'limited';
      const { wrappedKey } = await makeBlob('x', bytes(1));
      expect((await presign(bodyOf(newId(), wrappedKey, 6 * KB))).status).toBe(200);
      const res = await presign(bodyOf(newId(), wrappedKey, 6 * KB));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'storage_quota_exceeded', used: 0, limit: 10 * KB });
      expect((await presign(bodyOf(newId(), wrappedKey, 4 * KB))).status).toBe(200);
    });

    it('does not reserve twice when the same id is asked again, and keeps one row', async () => {
      addUser('limited', 10 * KB);
      currentUser = 'limited';
      const id = newId();
      const { wrappedKey } = await makeBlob(id, bytes(1));
      for (let i = 0; i < 3; i++) expect((await presign(bodyOf(id, wrappedKey, 8 * KB))).status).toBe(200);
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(2 * KB);
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(2 * KB);   // one row's promise, not three
      expect(registry.registryStmts.listStalePendingAttachments.all(Date.now() + 1)).toHaveLength(1);
    });

    it('takes the new wrapping and size when a pending id is asked again', async () => {
      const id = newId();
      const first = await makeBlob(id, bytes(10));
      await presign(bodyOf(id, first.wrappedKey, first.blob.length));
      const second = await makeBlob(id, bytes(500));
      expect((await presign(bodyOf(id, second.wrappedKey, second.blob.length))).status).toBe(200);
      expect(rowOf(id)).toMatchObject({ wrapped_key: second.wrappedKey, expected_size: second.blob.length });
    });

    it('says already_uploaded for a confirmed id, and id_taken for one that is someone else\'s', async () => {
      const { id, wrappedKey, blob } = await upload(bytes(50));
      const again = await presign(bodyOf(id, wrappedKey, blob.length));
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'already_uploaded' });

      addMember(ALICE);
      addMember(BOB);
      currentUser = BOB;
      const theirs = await presign(bodyOf(id, wrappedKey, blob.length));
      expect(theirs.status).toBe(409);
      expect(await theirs.json()).toEqual({ error: 'id_taken' });
      // Nor can a pending id be taken over.
      currentUser = ALICE;
      const pending = newId();
      const m = await makeBlob(pending, bytes(10));
      await presign(bodyOf(pending, m.wrappedKey, m.blob.length));
      currentUser = BOB;
      expect((await presign(bodyOf(pending, m.wrappedKey, m.blob.length))).status).toBe(409);
      expect(rowOf(pending)?.uploader_user_id).toBe(ALICE);
    });
  });

  // --- PUT content -------------------------------------------------------------------------------

  describe('PUT /:id/content', () => {
    async function presigned(plaintext = bytes(300)) {
      const id = newId();
      const m = await makeBlob(id, plaintext);
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      return { id, ...m };
    }

    it('stores the bytes under the uploader\'s folder, named by the id, and leaves no part behind', async () => {
      const { id, blob } = await presigned();
      expect((await put(id, blob)).status).toBe(204);
      expect(fs.readFileSync(fileOf(ALICE, id)).equals(Buffer.from(blob))).toBe(true);
      expect(fs.readdirSync(path.join(tmpDir, 'uploads', ALICE))).toEqual([id]);
    });

    it('refuses an id nobody presigned, someone else\'s, and one already confirmed', async () => {
      expect((await put(newId(), bytes(50))).status).toBe(404);
      const { id, blob } = await presigned();
      currentUser = BOB;
      expect((await put(id, blob)).status).toBe(404);
      currentUser = ALICE;
      await put(id, blob);
      await confirm(id);
      expect((await put(id, blob)).status).toBe(404);
    });

    it('refuses a Content-Length other than the declared size, before reading the body', async () => {
      const { id, blob } = await presigned();
      const res = await put(id, blob.slice(0, blob.length - 1));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'size_mismatch' });
      expect(fs.existsSync(fileOf(ALICE, id))).toBe(false);
    });

    it('cuts a body without a length that runs past the declared size, and keeps nothing of it', async () => {
      const { id, blob } = await presigned();
      const res = await putChunked(id, [blob, bytes(1)]);
      expect(res.status).toBe(400);
      expect(fs.existsSync(fileOf(ALICE, id))).toBe(false);
      expect(fs.existsSync(`${fileOf(ALICE, id)}.part`)).toBe(false);
      expect(rowOf(id)?.status).toBe('pending');
    });

    it('is refused once the upload URL has expired', async () => {
      const { id, blob } = await presigned();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 24 * 3600_000);
      try {
        expect((await put(id, blob)).status).toBe(410);
      } finally {
        vi.useRealTimers();
      }
    });

    it('replaces an earlier PUT of the same id', async () => {
      const { id, blob } = await presigned();
      await put(id, bytes(blob.length, 1));
      await put(id, blob);
      expect(fs.readFileSync(fileOf(ALICE, id)).equals(Buffer.from(blob))).toBe(true);
    });
  });

  // --- confirm -----------------------------------------------------------------------------------

  describe('POST /:id/confirm', () => {
    it('charges the owner what was stored, releases the promise and confirms the row', async () => {
      addUser('limited', 10 * KB);
      currentUser = 'limited';
      const { id, blob } = await upload(bytes(1000));
      expect(rowOf(id)).toMatchObject({ status: 'confirmed', size_bytes: blob.length });
      expect(usedOf('limited')).toBe(blob.length);
      // Promised once and charged once: only the stored bytes are counted against the limit.
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(10 * KB - blob.length);
    });

    it('is a no-op the second time: charged once, same answer', async () => {
      const { id, blob } = await upload(bytes(200));
      const again = await confirm(id);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ status: 'confirmed', size: blob.length });
      expect(usedOf(ALICE)).toBe(blob.length);
    });

    it('refuses a body smaller than declared: object and row removed, nothing charged, promise released', async () => {
      addUser('limited', 10 * KB);
      currentUser = 'limited';
      const id = newId();
      const m = await makeBlob(id, bytes(2000));
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(10 * KB - m.blob.length);
      expect((await putChunked(id, [m.blob.slice(0, 1500)])).status).toBe(204);
      const res = await confirm(id);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'size_mismatch' });
      expect(fs.existsSync(fileOf('limited', id))).toBe(false);
      expect(rowOf(id)).toBeUndefined();
      expect(usedOf('limited')).toBe(0);
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(10 * KB);
    });

    it('refuses a stored object larger than declared (a bucket that did not enforce the length)', async () => {
      const id = newId();
      const m = await makeBlob(id, bytes(100));
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      fs.mkdirSync(path.dirname(fileOf(ALICE, id)), { recursive: true });
      fs.writeFileSync(fileOf(ALICE, id), Buffer.concat([Buffer.from(m.blob), Buffer.alloc(1)]));
      expect((await confirm(id)).status).toBe(400);
      expect(fs.existsSync(fileOf(ALICE, id))).toBe(false);
      expect(rowOf(id)).toBeUndefined();
      expect(usedOf(ALICE)).toBe(0);
    });

    it('says not_uploaded when nothing was stored, and leaves the row to be retried', async () => {
      const id = newId();
      const m = await makeBlob(id, bytes(100));
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      const res = await confirm(id);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'not_uploaded' });
      expect(rowOf(id)?.status).toBe('pending');
      await put(id, m.blob);
      expect((await confirm(id)).status).toBe(200);
    });

    it('cannot be done for someone else\'s attachment, or one that does not exist', async () => {
      const id = newId();
      const m = await makeBlob(id, bytes(100));
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      await put(id, m.blob);
      currentUser = BOB;
      expect((await confirm(id)).status).toBe(404);
      expect((await confirm(newId())).status).toBe(404);
      expect(rowOf(id)?.status).toBe('pending');
    });
  });

  // --- resolve ------------------------------------------------------------------------------------

  describe('POST /resolve', () => {
    type Item = { id: string; error?: string; format?: number; workspaceId?: string; url?: string; expiresAt?: number; keyVersion?: number; wrappedKey?: string };
    const items = async (ids: string[]): Promise<Item[]> => ((await (await resolve(ids)).json()) as { items: Item[] }).items;

    it('gives a member the URL and wrapped key, which opens the file end to end', async () => {
      addMember(ALICE);
      const plaintext = new TextEncoder().encode('the secret page image');
      const up = await upload(plaintext);
      const [item] = await items([up.id]);
      expect(item).toMatchObject({ id: up.id, format: 2, keyVersion: 1, workspaceId: WS, url: `/api/attachments/${up.id}/content`, wrappedKey: up.wrappedKey });
      expect(item.expiresAt).toBeGreaterThan(Date.now());

      const fetched = new Uint8Array(await (await fetch(`${baseUrl}${item.url}`)).arrayBuffer());
      const a = await unwrapAttachmentKey(item.wrappedKey!, spaceKey, { workspaceId: WS, attachmentId: up.id, keyVersion: item.keyVersion! });
      expect(new TextDecoder().decode(await decryptBlob(fetched, a, up.id))).toBe('the secret page image');
    });

    it('refuses a non-member, and a member who was removed', async () => {
      addMember(ALICE);
      addMember(BOB);
      const up = await upload(bytes(50));
      currentUser = CAROL;
      expect(await items([up.id])).toEqual([{ id: up.id, error: 'forbidden' }]);
      currentUser = BOB;
      expect((await items([up.id]))[0].url).toBeDefined();
      registry.registryStmts.deleteWorkspaceKeyForUser.run(WS, BOB);
      expect(await items([up.id])).toEqual([{ id: up.id, error: 'forbidden' }]);
    });

    it('gives nothing, not even a URL, to a non-member, and never leaks the wrapped key', async () => {
      addMember(ALICE);
      const up = await upload(bytes(50));
      currentUser = CAROL;
      const raw = await (await resolve([up.id])).text();
      expect(raw).not.toContain(up.wrappedKey);
      expect(raw).not.toContain('/content');
    });

    it('lets the uploader read their own file in a Space nobody has a key for yet, and nobody else', async () => {
      const up = await upload(bytes(50));
      expect((await items([up.id]))[0].url).toBeDefined();
      currentUser = BOB;
      expect(await items([up.id])).toEqual([{ id: up.id, error: 'forbidden' }]);
    });

    it('answers not_found for an unknown id, a pending one, a malformed one, and a deleted one', async () => {
      addMember(ALICE);
      const pending = newId();
      const m = await makeBlob(pending, bytes(10));
      await presign(bodyOf(pending, m.wrappedKey, m.blob.length));
      const up = await upload(bytes(10));
      await json('DELETE', `/api/attachments/${up.id}`);
      expect(await items([newId(), pending, '../etc', up.id])).toEqual([
        { id: expect.any(String), error: 'not_found' }, { id: pending, error: 'not_found' },
        { id: '../etc', error: 'not_found' }, { id: up.id, error: 'not_found' },
      ]);
    });

    it('answers every id, in order, in one call', async () => {
      addMember(ALICE);
      const a = await upload(bytes(10));
      const b = await upload(bytes(20));
      const got = await items([b.id, 'nope', a.id, b.id]);
      expect(got.map((i) => i.id)).toEqual([b.id, 'nope', a.id, b.id]);
      expect(got.map((i) => i.error ?? 'ok')).toEqual(['ok', 'not_found', 'ok', 'ok']);
    });

    it('takes 1 to 100 ids and nothing else', async () => {
      expect((await resolve([])).status).toBe(400);
      expect((await resolve(Array.from({ length: 101 }, newId))).status).toBe(400);
      expect((await resolve(Array.from({ length: 100 }, newId))).status).toBe(200);
      expect((await json('POST', '/api/attachments/resolve', { ids: [1, 2] })).status).toBe(400);
      expect((await json('POST', '/api/attachments/resolve', {})).status).toBe(400);
    });
  });

  // --- reading and listing ----------------------------------------------------------------------

  describe('GET /:id/content', () => {
    it('streams the ciphertext to a member as an opaque download', async () => {
      addMember(ALICE);
      addMember(BOB);
      const up = await upload(bytes(300));
      currentUser = BOB;
      const res = await fetch(`${baseUrl}/api/attachments/${up.id}/content`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(up.blob))).toBe(true);
    });

    it('refuses a non-member and a removed member, and does not serve a pending file', async () => {
      addMember(ALICE);
      addMember(BOB);
      const up = await upload(bytes(50));
      currentUser = CAROL;
      expect((await fetch(`${baseUrl}/api/attachments/${up.id}/content`)).status).toBe(403);
      currentUser = BOB;
      registry.registryStmts.deleteWorkspaceKeyForUser.run(WS, BOB);
      expect((await fetch(`${baseUrl}/api/attachments/${up.id}/content`)).status).toBe(403);

      currentUser = ALICE;
      const id = newId();
      const m = await makeBlob(id, bytes(10));
      await presign(bodyOf(id, m.wrappedKey, m.blob.length));
      await put(id, m.blob);
      expect((await fetch(`${baseUrl}/api/attachments/${id}/content`)).status).toBe(404);
    });

    it('cannot be pointed at a path', async () => {
      expect((await fetch(`${baseUrl}/api/attachments/..%2Fusers/content`)).status).toBe(404);
    });
  });

  describe('GET /', () => {
    it('lists the caller\'s own confirmed attachments by id, with size and Space', async () => {
      const mine = await upload(bytes(10));
      const theirs = await upload(bytes(10), newId(), { user: BOB });
      const pending = newId();
      const m = await makeBlob(pending, bytes(10));
      await presign(bodyOf(pending, m.wrappedKey, m.blob.length));
      const list = (await (await json('GET', '/api/attachments')).json()) as { files: { id: string; size: number; workspaceId: string }[] };
      expect(list.files).toEqual([{ id: mine.id, size: mine.blob.length, workspaceId: WS }]);
      expect(list.files.map((f) => f.id)).not.toContain(theirs.id);
    });
  });

  // --- delete ------------------------------------------------------------------------------------

  describe('DELETE /:id', () => {
    it('removes the object and the row at once and gives the bytes back', async () => {
      const up = await upload(bytes(500));
      expect(usedOf(ALICE)).toBe(up.blob.length);
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(204);
      expect(fs.existsSync(fileOf(ALICE, up.id))).toBe(false);
      expect(rowOf(up.id)).toBeUndefined();
      expect(usedOf(ALICE)).toBe(0);
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(404);
    });

    it('cannot reach another account\'s attachment, or a path', async () => {
      const up = await upload(bytes(50));
      currentUser = BOB;
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(404);
      expect((await json('DELETE', '/api/attachments/..%2F..%2Fx')).status).toBe(404);
      expect(fs.existsSync(fileOf(ALICE, up.id))).toBe(true);
      expect(usedOf(ALICE)).toBe(up.blob.length);
    });

    it('lets the owner of the Space delete a member\'s attachment, and the bytes go back to the account that was charged', async () => {
      addMember(ALICE);
      addMember(BOB);
      registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: BOB });
      const up = await upload(bytes(400));            // Alice's, charged to Bob as the owner of the Space
      expect(usedOf(BOB)).toBe(up.blob.length);
      currentUser = BOB;
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(204);
      expect(rowOf(up.id)).toBeUndefined();
      expect(fs.existsSync(fileOf(ALICE, up.id))).toBe(false);
      expect(usedOf(BOB)).toBe(0);
      expect(usedOf(ALICE)).toBe(0);
    });

    it('does not let a member who owns nothing, or anyone when the Space has no known owner, delete another\'s', async () => {
      addMember(ALICE);
      addMember(BOB);
      const up = await upload(bytes(50));
      currentUser = BOB;
      // No owner is recorded for this Space: only the uploader may.
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(404);
      registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: ALICE });
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(404);
      expect(fs.existsSync(fileOf(ALICE, up.id))).toBe(true);
    });

    it('does not let the owner of another Space delete it', async () => {
      addMember(ALICE);
      const up = await upload(bytes(50));
      registry.registryStmts.recordSpaceOwner.run({ workspace_id: 'ws-other', owner_user_id: BOB });
      currentUser = BOB;
      expect((await json('DELETE', `/api/attachments/${up.id}`)).status).toBe(404);
    });

    it('releases the promise of a pending attachment', async () => {
      addUser('limited', 10 * KB);
      currentUser = 'limited';
      const id = newId();
      const m = await makeBlob(id, bytes(1));
      await presign(bodyOf(id, m.wrappedKey, 8 * KB));
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(2 * KB);
      await json('DELETE', `/api/attachments/${id}`);
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(10 * KB);
    });
  });

  // --- whose storage it is -------------------------------------------------------------------------

  describe('who is charged (docs/DISK-QUOTAS.md 4.5)', () => {
    const GUEST = 'user-guest';
    const HOST = 'user-host';
    const asHost = (limit: number | null = null) => {
      addUser(HOST, limit);
      addUser(GUEST);
      addMember(HOST);
      addMember(GUEST);
      registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: HOST });
    };

    it('charges the owner of the Space for a guest\'s upload, and the guest nothing', async () => {
      asHost();
      const up = await upload(bytes(600), newId(), { user: GUEST });
      expect(rowOf(up.id)).toMatchObject({ uploader_user_id: GUEST, owner_user_id: HOST, status: 'confirmed' });
      expect(usedOf(HOST)).toBe(up.blob.length);
      expect(usedOf(GUEST)).toBe(0);
    });

    it('charges the owner for the owner\'s own upload, as before', async () => {
      asHost();
      const up = await upload(bytes(300), newId(), { user: HOST });
      expect(rowOf(up.id)).toMatchObject({ uploader_user_id: HOST, owner_user_id: HOST });
      expect(usedOf(HOST)).toBe(up.blob.length);
    });

    it('checks the owner\'s limit, not the guest\'s: a guest with no room of their own uploads while the host has room', async () => {
      asHost(10 * 1024);
      registry.registryStmts.setUsedBytes.run({ user_id: GUEST, kind: 'attachments', used_bytes: 5_000_000, updated_at: 1 });
      addUser('tight', 10);                                  // a guest whose own limit is 10 bytes
      addMember('tight');
      const up = await upload(bytes(200), newId(), { user: 'tight' });
      expect(rowOf(up.id)?.owner_user_id).toBe(HOST);
    });

    it('refuses a guest\'s upload that does not fit the owner\'s room, with a 413 that tells the guest nothing of the host\'s usage', async () => {
      asHost(1000);
      currentUser = GUEST;
      const m = await makeBlob('big', bytes(2000));
      const res = await presign(bodyOf('big', m.wrappedKey, m.blob.length));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'storage_quota_exceeded', message: 'The storage limit is reached.' });
      expect(rowOf('big')).toBeUndefined();
    });

    it('tells the owner the figures, as before', async () => {
      asHost(1000);
      currentUser = HOST;
      const m = await makeBlob('big', bytes(2000));
      const res = await presign(bodyOf('big', m.wrappedKey, m.blob.length));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'storage_quota_exceeded', used: 0, limit: 1000 });
    });

    it('holds the owner\'s room against all of their guests together', async () => {
      asHost(1000);
      addUser('guest-2');
      addMember('guest-2');
      const m = await makeBlob('a', bytes(1));
      currentUser = GUEST;
      expect((await presign(bodyOf('a', m.wrappedKey, 700))).status).toBe(200);
      currentUser = 'guest-2';
      expect((await presign(bodyOf('b', m.wrappedKey, 700))).status).toBe(413);
      expect((await presign(bodyOf('b', m.wrappedKey, 300))).status).toBe(200);
      // And the host\'s own upload sees both holds.
      currentUser = HOST;
      expect((await presign(bodyOf('c', m.wrappedKey, 100))).status).toBe(413);
    });

    it('charges the uploader when the Space has no recorded owner, or its owner\'s account is gone', async () => {
      addUser(GUEST);
      addMember(GUEST);
      const a = await upload(bytes(50), newId(), { user: GUEST });
      expect(rowOf(a.id)?.owner_user_id).toBe(GUEST);

      registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: 'ghost' });   // no such account
      const b = await upload(bytes(50), newId(), { user: GUEST });
      expect(rowOf(b.id)?.owner_user_id).toBe(GUEST);
    });

    it('moves the charge to the owner when a pending upload is presigned again after the Space got one', async () => {
      addUser(HOST, 5000);
      addUser(GUEST, 5000);
      addMember(HOST);
      addMember(GUEST);
      currentUser = GUEST;
      const m = await makeBlob('p1', bytes(1));
      expect((await presign(bodyOf('p1', m.wrappedKey, 800))).status).toBe(200);
      expect(rowOf('p1')?.owner_user_id).toBe(GUEST);
      expect(quota.remainingBytes(GUEST, 5000)).toBe(4200);

      registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: HOST });
      expect((await presign(bodyOf('p1', m.wrappedKey, 800))).status).toBe(200);
      expect(rowOf('p1')?.owner_user_id).toBe(HOST);
      expect(quota.remainingBytes(HOST, 5000)).toBe(4200);
      expect(quota.remainingBytes(GUEST, 5000)).toBe(5000);
    });

    it('gives the bytes back to the owner when the guest deletes, and when the owner does', async () => {
      asHost();
      const one = await upload(bytes(400), newId(), { user: GUEST });
      const two = await upload(bytes(400), newId(), { user: GUEST });
      expect(usedOf(HOST)).toBe(one.blob.length + two.blob.length);
      currentUser = GUEST;
      expect((await json('DELETE', `/api/attachments/${one.id}`)).status).toBe(204);
      expect(usedOf(HOST)).toBe(two.blob.length);
      currentUser = HOST;
      expect((await json('DELETE', `/api/attachments/${two.id}`)).status).toBe(204);
      expect(usedOf(HOST)).toBe(0);
      expect(usedOf(GUEST)).toBe(0);
    });

    it('reconciles to the same figures: the owner\'s usage is what the confirmed attachments in their Spaces add up to', async () => {
      asHost();
      await upload(bytes(100), newId(), { user: GUEST });
      await upload(bytes(100), newId(), { user: HOST });
      const before = usedOf(HOST);
      quota.reconcileUserUsage(HOST);
      quota.reconcileUserUsage(GUEST);
      expect(usedOf(HOST)).toBe(before);
      expect(usedOf(GUEST)).toBe(0);
    });

    it('lists, for the guest, what they uploaded though the host is charged', async () => {
      asHost();
      const up = await upload(bytes(10), newId(), { user: GUEST });
      currentUser = GUEST;
      const list = (await (await json('GET', '/api/attachments')).json()) as { files: { id: string }[] };
      expect(list.files.map((f) => f.id)).toEqual([up.id]);
    });
  });

  // --- cleanup --------------------------------------------------------------------------------------

  describe('cleanupAttachments', () => {
    it('removes a pending attachment older than an hour with its object, and keeps newer and confirmed ones', async () => {
      const old = newId();
      const fresh = newId();
      const kept = await upload(bytes(10));
      const realNow = Date.now();
      const start = async (id: string) => {
        const m = await makeBlob(id, bytes(10));
        await presign(bodyOf(id, m.wrappedKey, m.blob.length));
        await put(id, m.blob);
      };
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(realNow - 2 * 3600_000);
        await start(old);
        vi.setSystemTime(realNow);
        await start(fresh);
      } finally {
        vi.useRealTimers();
      }

      expect(await lib.cleanupAttachments()).toBe(1);
      expect(rowOf(old)).toBeUndefined();
      expect(fs.existsSync(fileOf(ALICE, old))).toBe(false);
      expect(rowOf(fresh)?.status).toBe('pending');
      expect(fs.existsSync(fileOf(ALICE, fresh))).toBe(true);
      expect(rowOf(kept.id)?.status).toBe('confirmed');
      expect(fs.existsSync(fileOf(ALICE, kept.id))).toBe(true);
    });
  });
});
