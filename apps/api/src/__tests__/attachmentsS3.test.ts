// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * /api/attachments with a bucket configured (docs/ATTACHMENT-ENCRYPTION.md 6, S3 mode): the bytes go
 * straight to the bucket by presigned URL, the API only measures them, and only the cleanup job deletes.
 * The bucket is a fake with the same interface as the real one (lib/objectStore.ts); what the real
 * presigner produces is checked in objectStore.test.ts.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const WS = 'ws-1';
const WRAPPED = 'w'.repeat(96);
const KB = 1024;

/** A bucket in memory. It records what the API asked of it, and lets a test play the client's PUT. */
class FakeBucket {
  objects = new Map<string, number>();
  presigned: { key: string; size: number; contentType: string; expiresInSeconds: number }[] = [];
  gets: { key: string; expiresInSeconds: number }[] = [];
  deleted: string[] = [];
  failPresign = false;
  failDelete = false;
  async presignPut(key: string, size: number, contentType: string, expiresInSeconds: number) {
    if (this.failPresign) throw new Error('bucket down');
    this.presigned.push({ key, size, contentType, expiresInSeconds });
    return { url: `https://bucket.test/${key}?X-Amz-Signature=put${size}`, headers: { 'Content-Type': contentType, 'Content-Length': String(size) } };
  }
  async presignGet(key: string, expiresInSeconds: number) {
    this.gets.push({ key, expiresInSeconds });
    return `https://bucket.test/${key}?X-Amz-Signature=get`;
  }
  async head(key: string) { return this.objects.get(key) ?? null; }
  async delete(key: string) {
    if (this.failDelete) throw new Error('forbidden');
    this.deleted.push(key);
    this.objects.delete(key);
  }
  /** The client's PUT to the signed URL. */
  put(key: string, size: number) { this.objects.set(key, size); }
}

describe('attachments router (S3 mode)', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let registry: typeof import('../db/registry');
  let quota: typeof import('../lib/quota');
  let lib: typeof import('../lib/attachments');
  let bucket: FakeBucket;
  let currentUser = ALICE;

  const addUser = (id: string, limit: number | null = null): void => {
    registry.registryStmts.createUser.run({
      id, email: `${id}@example.com`, properties: JSON.stringify(limit === null ? {} : { service: { diskQuotaBytes: limit } }),
      created_at: Date.now(), status: 'active', public_key: null, wrapped_content_key: null, user_type: 'free',
    });
  };
  const addMember = (userId: string): void => {
    registry.registryStmts.insertWorkspaceKey.run({ workspace_id: WS, user_id: userId, wrapped_key: 'sealed', granted_at: 1 });
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-attachments-s3-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.UPLOAD_MAX_SIZE_MB = '1';
    currentUser = ALICE;
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
    const objectStore = await import('../lib/objectStore');
    bucket = new FakeBucket();
    objectStore.setObjectStoreForTests(bucket);
    addUser(ALICE);
    addUser(BOB);
    addMember(ALICE);
    addMember(BOB);
    const { attachmentsRouter } = await import('../routes/attachments');
    const app = express();
    app.use(express.json());
    app.use('/api/attachments', attachmentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
      server = null;
    }
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'NODE_ENV', 'UPLOAD_MAX_SIZE_MB']) delete process.env[k];
    vi.resetModules();
  });

  const json = (method: string, url: string, body?: unknown): Promise<globalThis.Response> =>
    fetch(`${baseUrl}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const presign = (id: string, size: number, extra: Record<string, unknown> = {}) =>
    json('POST', '/api/attachments/presign', { workspaceId: WS, attachmentId: id, size, kind: 'file', keyVersion: 1, wrappedKey: WRAPPED, ...extra });
  const confirm = (id: string) => json('POST', `/api/attachments/${id}/confirm`);
  const rowOf = (id: string) => registry.registryStmts.getAttachment.get(id) as import('../db/registry').AttachmentRow | undefined;

  /** presign, the client's PUT to the bucket, confirm */
  async function upload(id: string, size = 500) {
    expect((await presign(id, size)).status).toBe(200);
    bucket.put(`a/${id}`, size);
    expect((await confirm(id)).status).toBe(200);
  }

  describe('POST /presign', () => {
    it('answers with a URL into the bucket, signed for this size and type, and writes nothing to the disk', async () => {
      const res = await presign('att-1', 2 * KB);
      expect(res.status).toBe(200);
      const body = await res.json() as { mode: string; uploadUrl: string; headers: Record<string, string>; expiresAt: number };
      expect(body.mode).toBe('s3');
      expect(body.uploadUrl).toBe('https://bucket.test/a/att-1?X-Amz-Signature=put2048');
      expect(body.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Length': '2048' });
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      // Asked of the bucket: this key, exactly this size, an opaque type, and the PUT lifetime (15 minutes by default).
      expect(bucket.presigned).toEqual([{ key: 'a/att-1', size: 2 * KB, contentType: 'application/octet-stream', expiresInSeconds: 900 }]);
      expect(rowOf('att-1')).toMatchObject({ status: 'pending', storage: 's3', storage_key: 'a/att-1', expected_size: 2 * KB });
      expect(fs.existsSync(path.join(tmpDir, 'uploads'))).toBe(false);
    });

    it('reserves the bytes against the quota as in local mode', async () => {
      addUser('limited', 10 * KB);
      addMember('limited');
      currentUser = 'limited';
      expect((await presign('a1', 6 * KB)).status).toBe(200);
      const res = await presign('a2', 6 * KB);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'storage_quota_exceeded' });
      expect(bucket.presigned).toHaveLength(1);
    });

    it('is a 500, with the bytes given back and no row, when the bucket cannot sign', async () => {
      addUser('limited', 10 * KB);
      addMember('limited');
      currentUser = 'limited';
      bucket.failPresign = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await presign('a1', 8 * KB)).status).toBe(500);
      warn.mockRestore();
      expect(rowOf('a1')).toBeUndefined();
      expect(quota.remainingBytes('limited', 10 * KB)).toBe(10 * KB);
    });

    it('signs a fresh URL for a retried id and keeps one row', async () => {
      await presign('att-1', 1000);
      await presign('att-1', 1500);
      expect(bucket.presigned.map((p) => p.size)).toEqual([1000, 1500]);
      expect(rowOf('att-1')).toMatchObject({ expected_size: 1500, storage: 's3' });
    });

    it('moves a pending row begun on the disk to the bucket when the store has been configured since', async () => {
      const objectStore = await import('../lib/objectStore');
      objectStore.setObjectStoreForTests(null);
      expect((await presign('att-1', 1000)).status).toBe(200);
      expect(rowOf('att-1')).toMatchObject({ storage: 'local', storage_key: `${ALICE}/att-1` });
      objectStore.setObjectStoreForTests(bucket);
      const res = await presign('att-1', 1000);
      expect(((await res.json()) as { mode: string }).mode).toBe('s3');
      expect(rowOf('att-1')).toMatchObject({ storage: 's3', storage_key: 'a/att-1' });
    });

    it('does not accept the bytes itself: PUT to the API for a bucket row is refused', async () => {
      await presign('att-1', 3);
      const res = await fetch(`${baseUrl}/api/attachments/att-1/content`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
      expect(res.status).toBe(404);
      expect(fs.existsSync(path.join(tmpDir, 'uploads'))).toBe(false);
    });
  });

  describe('POST /confirm', () => {
    it('measures the object in the bucket and charges the owner', async () => {
      await upload('att-1', 700);
      expect(rowOf('att-1')).toMatchObject({ status: 'confirmed', size_bytes: 700 });
      expect(quota.attachmentsUsed(ALICE)).toBe(700);
    });

    it('says not_uploaded while there is no object, and keeps the row pending', async () => {
      await presign('att-1', 700);
      const res = await confirm('att-1');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'not_uploaded' });
      expect(rowOf('att-1')?.status).toBe('pending');
    });

    it.each([['smaller', 699], ['larger', 701], ['much larger', 7000]])('refuses an object %s than declared: nothing charged, the object left to the cleanup job', async (_label, stored) => {
      await presign('att-1', 700);
      bucket.put('a/att-1', stored);
      const res = await confirm('att-1');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'size_mismatch' });
      expect(quota.attachmentsUsed(ALICE)).toBe(0);
      // The API cannot delete from the bucket: it marks the row, and the cleanup job does the rest.
      expect(bucket.deleted).toEqual([]);
      expect(rowOf('att-1')?.status).toBe('deleted');
      expect(await lib.cleanupAttachments()).toBe(1);
      expect(bucket.deleted).toEqual(['a/att-1']);
      expect(rowOf('att-1')).toBeUndefined();
    });

    it('lets the same id be tried again after a mismatch, and the cleanup job then leaves it alone', async () => {
      await presign('att-1', 700);
      bucket.put('a/att-1', 900);
      await confirm('att-1');
      expect(rowOf('att-1')?.status).toBe('deleted');

      expect((await presign('att-1', 700)).status).toBe(200);
      expect(rowOf('att-1')?.status).toBe('pending');
      bucket.put('a/att-1', 700);
      expect(await lib.cleanupAttachments()).toBe(0);
      expect((await confirm('att-1')).status).toBe(200);
      expect(bucket.deleted).toEqual([]);
    });

    it('is a no-op the second time, and is not charged twice', async () => {
      await upload('att-1', 700);
      expect((await confirm('att-1')).status).toBe(200);
      expect(quota.attachmentsUsed(ALICE)).toBe(700);
    });

    it('is a 500 when the bucket cannot be asked, and leaves the row pending', async () => {
      await presign('att-1', 700);
      vi.spyOn(bucket, 'head').mockRejectedValueOnce(new Error('timeout'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await confirm('att-1')).status).toBe(500);
      warn.mockRestore();
      expect(rowOf('att-1')?.status).toBe('pending');
    });
  });

  describe('reading', () => {
    it('resolve gives a member a signed URL into the bucket, with the PUT-independent GET lifetime (5 minutes by default)', async () => {
      await upload('att-1');
      currentUser = BOB;
      const res = await json('POST', '/api/attachments/resolve', { ids: ['att-1'] });
      const [item] = (await res.json() as { items: { url: string; expiresAt: number; wrappedKey: string; workspaceId: string }[] }).items;
      expect(item.url).toBe('https://bucket.test/a/att-1?X-Amz-Signature=get');
      expect(item).toMatchObject({ wrappedKey: WRAPPED, workspaceId: WS });
      expect(item.expiresAt - Date.now()).toBeGreaterThan(250_000);
      expect(item.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
      expect(bucket.gets).toEqual([{ key: 'a/att-1', expiresInSeconds: 300 }]);
    });

    it('resolve signs nothing for a non-member, a pending attachment or an unknown id', async () => {
      await upload('att-1');
      await presign('att-2', 100);
      registry.registryStmts.deleteWorkspaceKeyForUser.run(WS, BOB);
      currentUser = BOB;
      const res = await json('POST', '/api/attachments/resolve', { ids: ['att-1', 'att-2', 'nope'] });
      expect((await res.json() as { items: unknown[] }).items).toEqual([
        { id: 'att-1', error: 'forbidden' }, { id: 'att-2', error: 'not_found' }, { id: 'nope', error: 'not_found' },
      ]);
      expect(bucket.gets).toEqual([]);
    });

    it('resolve answers disk and bucket attachments in one call, each with its own kind of URL', async () => {
      await upload('att-1');
      const objectStore = await import('../lib/objectStore');
      objectStore.setObjectStoreForTests(null);
      await presign('att-local', 100);
      fs.mkdirSync(path.join(tmpDir, 'uploads', ALICE), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', ALICE, 'att-local'), Buffer.alloc(100));
      await confirm('att-local');
      objectStore.setObjectStoreForTests(bucket);
      const res = await json('POST', '/api/attachments/resolve', { ids: ['att-1', 'att-local'] });
      const urls = (await res.json() as { items: { url: string }[] }).items.map((i) => i.url);
      expect(urls).toEqual(['https://bucket.test/a/att-1?X-Amz-Signature=get', '/api/attachments/att-local/content']);
    });

    it('GET /:id/content redirects a member to the signed URL, and refuses a non-member', async () => {
      await upload('att-1');
      const ok = await json('GET', '/api/attachments/att-1/content');
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('https://bucket.test/a/att-1?X-Amz-Signature=get');
      registry.registryStmts.deleteWorkspaceKeyForUser.run(WS, ALICE);
      expect((await json('GET', '/api/attachments/att-1/content')).status).toBe(403);
    });
  });

  describe('DELETE and the cleanup job', () => {
    it('the API gives the bytes back at once and never deletes from the bucket; the cleanup job does', async () => {
      await upload('att-1', 900);
      expect(quota.attachmentsUsed(ALICE)).toBe(900);
      expect((await json('DELETE', '/api/attachments/att-1')).status).toBe(204);
      expect(quota.attachmentsUsed(ALICE)).toBe(0);
      expect(bucket.deleted).toEqual([]);
      expect(rowOf('att-1')?.status).toBe('deleted');
      // Not readable meanwhile.
      const res = await json('POST', '/api/attachments/resolve', { ids: ['att-1'] });
      expect((await res.json() as { items: unknown[] }).items).toEqual([{ id: 'att-1', error: 'not_found' }]);

      expect(await lib.cleanupAttachments()).toBe(1);
      expect(bucket.deleted).toEqual(['a/att-1']);
      expect(rowOf('att-1')).toBeUndefined();
    });

    it('removes a pending upload older than an hour, object included, and not a newer one', async () => {
      const realNow = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(realNow - 2 * 3600_000);
        await presign('old', 100);
        vi.setSystemTime(realNow);
        await presign('fresh', 100);
      } finally { vi.useRealTimers(); }
      bucket.put('a/old', 100);
      expect(await lib.cleanupAttachments()).toBe(1);
      expect(bucket.deleted).toEqual(['a/old']);
      expect(rowOf('old')).toBeUndefined();
      expect(rowOf('fresh')?.status).toBe('pending');
    });

    it('keeps a row whose object it could not remove, and tries again next time', async () => {
      await upload('att-1');
      await json('DELETE', '/api/attachments/att-1');
      bucket.failDelete = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await lib.cleanupAttachments()).toBe(0);
      warn.mockRestore();
      expect(rowOf('att-1')?.status).toBe('deleted');
      bucket.failDelete = false;
      expect(await lib.cleanupAttachments()).toBe(1);
    });

    it('leaves bucket rows alone when the store cannot delete', async () => {
      await upload('att-1');
      await json('DELETE', '/api/attachments/att-1');
      const objectStore = await import('../lib/objectStore');
      objectStore.setObjectStoreForTests({ presignPut: bucket.presignPut.bind(bucket), presignGet: bucket.presignGet.bind(bucket), head: bucket.head.bind(bucket) });
      expect(await lib.cleanupAttachments()).toBe(0);
      expect(rowOf('att-1')?.status).toBe('deleted');
    });
  });
});
