// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * The attachment path end to end, with nothing between the layers faked: the web client's own modules
 * (the bearer HTTP client, `uploadEncrypted`, the batched resolver) talk over real HTTP to the real
 * routes behind the real `requireAuth`, with the real format 2 encryption. In S3 mode the store is the
 * real one too, pointed at a real S3 server (docs/ATTACHMENT-ENCRYPTION.md 14.1).
 *
 * Always runs in local mode. S3 mode runs when `S3_LIVE=1` and the S3_* variables point at a bucket that
 * may be written to (see objectStore.live.test.ts); it is what proves the client keeps its token from the
 * bucket, which the browser specs cannot (the web app authenticates by cookie).
 */
import express from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateContentKey } from '@ubimate/crypto';
import { UploadQuotaExceededError, createBearerHttpClient, type UbimateClient } from '../../../web/src/api/client';
import { uploadEncrypted } from '../../../web/src/api/encryptedUpload';
import { createAttachmentResolver } from '../../../web/src/api/attachmentResolver';
import { AttachmentUnavailableError } from '../../../web/src/lib/attachments';
import { loadS3Config } from '../lib/objectStore';
import { ensureTestBucket } from './helpers/s3Bucket';

const S3 = process.env.S3_LIVE === '1' ? loadS3Config() : null;
const MODES: ('local' | 's3')[] = S3 ? ['local', 's3'] : ['local'];

const WS = 'ws-int';
const OWNER = 'user-owner';
const GUEST = 'user-guest';
const OUTSIDER = 'user-outsider';
const KB = 1024;

/** Bytes made of a pattern: `randomBytes` of a megabyte is slow under libsodium's wasm RNG. */
const bytesOf = (n: number, seed = 1): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

describe.each(MODES)('attachments end to end (%s mode)', (mode) => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let registry: typeof import('../db/registry');
  let lib: typeof import('../lib/attachments');
  let objectStore: typeof import('../lib/objectStore');
  let spaceKey: Uint8Array;
  const tokens: Record<string, string> = {};
  /** Every call the client made through `fetch`: where, and with which credentials. */
  let calls: { url: string; method: string; authorization?: string; credentials?: RequestCredentials }[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => { if (S3) await ensureTestBucket(S3); }, 60_000);

  const client = (user: string): UbimateClient => createBearerHttpClient(baseUrl, tokens[user]);
  const file = (data: Uint8Array<ArrayBuffer>, type = 'image/png') => new File([data], 'name-the-server-must-not-see.png', { type });
  const reader = (user: string) => {
    const c = client(user);
    return createAttachmentResolver({
      resolve: (ids) => c.resolveAttachments(ids),
      download: (url) => c.downloadRaw(url),
      getSpaceKeys: () => [spaceKey],
    });
  };
  const addUser = (id: string, limit?: number) => {
    registry.registryStmts.createUser.run({
      id, email: `${id}@example.com`, properties: JSON.stringify(limit === undefined ? {} : { service: { diskQuotaBytes: limit } }),
      created_at: Date.now(), status: 'active', public_key: null, wrapped_content_key: null, user_type: 'free',
    });
  };
  const bucketCalls = () => calls.filter((c) => !c.url.startsWith(baseUrl));
  const apiCalls = () => calls.filter((c) => c.url.startsWith(baseUrl));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-attachments-int-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'int-test-secret';
    vi.resetModules();
    registry = await import('../db/registry');
    lib = await import('../lib/attachments');
    objectStore = await import('../lib/objectStore');
    objectStore.setObjectStoreForTests(mode === 's3' ? objectStore.createS3ObjectStore(S3!) : null);

    for (const id of [OWNER, GUEST, OUTSIDER]) addUser(id, id === OWNER ? 64 * KB : undefined);
    for (const id of [OWNER, GUEST]) registry.registryStmts.insertWorkspaceKey.run({ workspace_id: WS, user_id: id, wrapped_key: 'sealed', granted_at: 1 });
    registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: OWNER });
    const jwt = (await import('jsonwebtoken')).default;
    for (const id of [OWNER, GUEST, OUTSIDER]) tokens[id] = jwt.sign({ sub: id, email: `${id}@example.com` }, 'int-test-secret', { expiresIn: '1h' });
    spaceKey = await generateContentKey();

    const { attachmentsRouter } = await import('../routes/attachments');
    const { usageRouter } = await import('../routes/usage');
    const app = express();
    app.use(express.json());
    app.use('/api/attachments', attachmentsRouter);
    app.use('/api/usage', usageRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? undefined, credentials: init?.credentials });
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) {
      await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
      server = null;
    }
    // Take what the run left in the bucket out of it.
    if (mode === 's3') await lib.cleanupAttachments(Date.now() + 2 * 3600_000).catch(() => {});
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'NODE_ENV', 'JWT_SECRET']) delete process.env[k];
    vi.resetModules();
  });

  it('a member uploads, another member reads it back: the same bytes, through the signed URL in S3 mode', async () => {
    const data = bytesOf(40 * KB);
    const { url } = await uploadEncrypted(client(OWNER), file(data), spaceKey, WS, 'att-1');
    expect(url).toBe('attachment:att-1');

    const read = await reader(GUEST).read('att-1');
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);

    // The server stored a format 2 blob, not the file.
    const row = registry.registryStmts.getAttachment.get('att-1') as import('../db/registry').AttachmentRow;
    expect(row).toMatchObject({ status: 'confirmed', storage: mode === 's3' ? 's3' : 'local', size_bytes: data.length + 41 });
  });

  it('keeps its credentials for its own server: the token goes to the API and never to the bucket', async () => {
    await uploadEncrypted(client(OWNER), file(bytesOf(2 * KB)), spaceKey, WS, 'att-1');
    await reader(GUEST).read('att-1');

    for (const c of apiCalls()) expect(c.authorization, `${c.method} ${c.url}`).toMatch(/^Bearer \S+$/);
    if (mode === 's3') {
      // Presign, PUT, confirm, resolve and the GET: the PUT and the GET went to the bucket, bare.
      expect(bucketCalls().map((c) => c.method).sort()).toEqual(['GET', 'PUT']);
      for (const c of bucketCalls()) {
        expect(c.authorization, `${c.method} ${c.url}`).toBeUndefined();
        expect(c.credentials).toBe('omit');
      }
    } else {
      expect(bucketCalls()).toEqual([]);
    }
  });

  it('batches the reads of a page into one resolve call', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await uploadEncrypted(client(OWNER), file(bytesOf(KB, id.charCodeAt(0))), spaceKey, WS, `att-${id}`);
    calls = [];
    const r = reader(GUEST);
    const all = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => r.read(`att-${id}`)));
    expect(all.every((b) => b.length === KB)).toBe(true);
    expect(apiCalls().filter((c) => c.url.endsWith('/api/attachments/resolve'))).toHaveLength(1);
  });

  it('refuses a non-member, and a member who has been removed', async () => {
    await uploadEncrypted(client(OWNER), file(bytesOf(KB)), spaceKey, WS, 'att-1');
    await expect(reader(OUTSIDER).read('att-1')).rejects.toBeInstanceOf(AttachmentUnavailableError);

    expect((await reader(GUEST).read('att-1')).length).toBe(KB);
    registry.registryStmts.deleteWorkspaceKeyForUser.run(WS, GUEST);
    await expect(reader(GUEST).read('att-1')).rejects.toBeInstanceOf(AttachmentUnavailableError);
    // And the API gives the removed member no URL at all, so there is nothing for a bucket to be asked.
    const items = await client(GUEST).resolveAttachments(['att-1']);
    expect(items).toEqual([{ id: 'att-1', error: 'forbidden' }]);
  });

  it('charges the host for a guest\'s upload, and tells a guest nothing of the host\'s room', async () => {
    await uploadEncrypted(client(GUEST), file(bytesOf(10 * KB)), spaceKey, WS, 'att-g');
    const usage = await client(OWNER).getUsage();
    expect(usage.attachments.used).toBe(10 * KB + 41);
    expect((await client(GUEST).getUsage()).attachments.used).toBe(0);

    // The host's limit is 64 KiB: a guest's upload that does not fit is refused, without the host's figures.
    const guestErr = await uploadEncrypted(client(GUEST), file(bytesOf(60 * KB)), spaceKey, WS, 'att-big').catch((e: unknown) => e);
    expect(guestErr).toBeInstanceOf(UploadQuotaExceededError);
    expect(guestErr).toMatchObject({ used: 0, limit: 0 });
    // The host is told the figures.
    const ownerErr = await uploadEncrypted(client(OWNER), file(bytesOf(60 * KB)), spaceKey, WS, 'att-big2').catch((e: unknown) => e);
    expect(ownerErr).toBeInstanceOf(UploadQuotaExceededError);
    expect(ownerErr).toMatchObject({ used: 10 * KB + 41, limit: 64 * KB });
  });

  it('an upload repeated after a lost answer is a success, and is stored and charged once', async () => {
    await uploadEncrypted(client(OWNER), file(bytesOf(3 * KB)), spaceKey, WS, 'att-1');
    const again = await uploadEncrypted(client(OWNER), file(bytesOf(3 * KB)), spaceKey, WS, 'att-1');
    expect(again.url).toBe('attachment:att-1');
    expect((await client(OWNER).getUsage()).attachments.used).toBe(3 * KB + 41);
  });

  it('the uploader and the host can delete it; it is then neither listed nor readable, and the room is back', async () => {
    await uploadEncrypted(client(GUEST), file(bytesOf(5 * KB)), spaceKey, WS, 'att-1');
    expect((await client(GUEST).listUploads()).map((f) => f.id)).toEqual(['att-1']);
    await client(OWNER).deleteUpload('att-1');
    expect(await client(GUEST).listUploads()).toEqual([]);
    expect((await client(OWNER).getUsage()).attachments.used).toBe(0);
    await expect(reader(GUEST).read('att-1')).rejects.toBeInstanceOf(AttachmentUnavailableError);
    // Removed from storage by the cleanup job (a bucket's object) or at once (the disk's).
    if (mode === 's3') {
      await lib.cleanupAttachments();
      expect(await objectStore.getObjectStore()!.head('a/att-1')).toBeNull();
    } else {
      expect(fs.existsSync(path.join(tmpDir, 'uploads', GUEST, 'att-1'))).toBe(false);
    }
  });

  it('an outsider cannot delete, resolve, list or read it', async () => {
    await uploadEncrypted(client(OWNER), file(bytesOf(KB)), spaceKey, WS, 'att-1');
    await expect(client(OUTSIDER).deleteUpload('att-1')).rejects.toThrow();
    expect(await client(OUTSIDER).listUploads()).toEqual([]);
    expect(await client(OUTSIDER).resolveAttachments(['att-1'])).toEqual([{ id: 'att-1', error: 'forbidden' }]);
    expect(Buffer.from(await reader(OWNER).read('att-1')).length).toBe(KB);
  });

  if (mode === 's3') {
    it('the bucket itself refuses a body that is not the length that was signed', async () => {
      const { createS3ObjectStore } = objectStore;
      const store = createS3ObjectStore(S3!);
      const key = `a/int-${Date.now()}`;
      const { url, headers } = await store.presignPut(key, 1000, 'application/octet-stream', 60);
      const { 'Content-Length': _l, ...h } = headers;
      const res = await realFetch(url, { method: 'PUT', headers: h, body: new Uint8Array(1001) });
      expect(res.status).toBe(403);
      expect(await store.head(key)).toBeNull();
    });
  }
});
