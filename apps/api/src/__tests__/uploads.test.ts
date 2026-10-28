// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for POST /api/uploads — file upload endpoint.
 *
 * Covers:
 * - Successful upload returns a URL
 * - Unauthenticated requests are rejected
 * - Missing file field is rejected
 * - Per-type size limits are enforced (image, audio, video, generic)
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDbHandle } from '../db/database';

const TEST_USER_ID = 'test-user-uploads';

/** Build a multipart/form-data body with a single `file` field. */
function buildFormData(filename: string, mimeType: string, sizeBytes: number): FormData {
  const content = Buffer.alloc(sizeBytes, 'x');
  const blob = new Blob([content], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);
  return form;
}

describe('uploads router', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-uploads-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    // Tight per-type limits for testing (in MB)
    process.env.MAX_IMAGE_UPLOAD_MB = '1';
    process.env.MAX_AUDIO_UPLOAD_MB = '2';
    process.env.MAX_VIDEO_UPLOAD_MB = '3';
    process.env.UPLOAD_MAX_SIZE_MB = '1';

    vi.resetModules();

    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = TEST_USER_ID;
        (req as Request & { userDbHandle: UserDbHandle }).userDbHandle = {} as UserDbHandle;
        next();
      },
    }));

    const { uploadsRouter } = await import('../routes/uploads');
    const app = express();
    app.use('/api/uploads', uploadsRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    delete process.env.MAX_IMAGE_UPLOAD_MB;
    delete process.env.MAX_AUDIO_UPLOAD_MB;
    delete process.env.MAX_VIDEO_UPLOAD_MB;
    delete process.env.UPLOAD_MAX_SIZE_MB;
    vi.resetModules();
  });

  it('accepts a valid image upload and returns a URL', async () => {
    const form = buildFormData('photo.jpg', 'image/jpeg', 512);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(new RegExp(`^/uploads/${TEST_USER_ID}/`));
    expect(body.url).toMatch(/\.jpg$/);

    // File should exist on disk
    const filePath = path.join(tmpDir, body.url);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('accepts a generic file (non-image/audio/video) upload', async () => {
    const form = buildFormData('notes.pdf', 'application/pdf', 512);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(/\.pdf$/);
  });

  it('rejects upload without a file field', async () => {
    const form = new FormData();
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no file/i);
  });

  it('rejects an image that exceeds the image size limit', async () => {
    // MAX_IMAGE_UPLOAD_MB=1, so 1.1 MB should be rejected
    const form = buildFormData('big.jpg', 'image/jpeg', 1.1 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('rejects an audio file that exceeds the audio size limit', async () => {
    // MAX_AUDIO_UPLOAD_MB=2, so 2.1 MB should be rejected
    const form = buildFormData('track.mp3', 'audio/mpeg', 2.1 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('rejects a video file that exceeds the video size limit', async () => {
    // MAX_VIDEO_UPLOAD_MB=3, so 3.1 MB should be rejected
    const form = buildFormData('clip.mp4', 'video/mp4', 3.1 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('does not leave a file on disk after a size-limit rejection', async () => {
    const uploadsDir = path.join(tmpDir, 'uploads', TEST_USER_ID);
    const form = buildFormData('big.jpg', 'image/jpeg', 1.1 * 1024 * 1024);
    await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    // uploads dir should be empty (file was deleted) or not exist at all
    if (fs.existsSync(uploadsDir)) {
      expect(fs.readdirSync(uploadsDir)).toHaveLength(0);
    }
  });

  it('accepts an audio file within its limit even if it exceeds the generic limit', async () => {
    // UPLOAD_MAX_SIZE_MB=1, MAX_AUDIO_UPLOAD_MB=2 — 1.5 MB audio should pass
    const form = buildFormData('track.mp3', 'audio/mpeg', 1.5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
  });
});

// ── Demo upload block ──────────────────────────────────────────────────────────

describe('uploads router — demo mode block', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-uploads-demo-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';

    vi.resetModules();

    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = TEST_USER_ID;
        (req as Request & { userDbHandle: UserDbHandle }).userDbHandle = {} as UserDbHandle;
        // Mark as demo session
        (req as Request & { isDemo: boolean }).isDemo = true;
        next();
      },
    }));

    const { uploadsRouter } = await import('../routes/uploads');
    const app = express();
    app.use('/api/uploads', uploadsRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  it('blocks file uploads for demo users with 403', async () => {
    const form = buildFormData('photo.jpg', 'image/jpeg', 512);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/demo/i);
  });

  it('does not write any file to disk when demo upload is blocked', async () => {
    const form = buildFormData('photo.jpg', 'image/jpeg', 512);
    await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
    const uploadsDir = path.join(tmpDir, 'uploads', TEST_USER_ID);
    if (fs.existsSync(uploadsDir)) {
      expect(fs.readdirSync(uploadsDir)).toHaveLength(0);
    }
  });
});

// ── GET /uploads/* — authenticated file serving ──────────────────────────────

const NO_IMAGE_SVG_SNIP = '<svg xmlns';

describe('upload file serving (GET /uploads/*)', () => {
  let serveDir: string;
  // Closure variables hold the two servers and their base URLs.
  let authedServer: import('net').Server | null = null;
  let unauthServer: import('net').Server | null = null;
  let authedBase: string;
  let unauthBase: string;

  beforeEach(async () => {
    serveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-serve-test-'));

    // Write a real file that can be served.
    const userDir = path.join(serveDir, 'uploads', 'user-abc');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'photo.jpg'), Buffer.from('FAKEJPEG'));

    // Replicates the app.use('/uploads', ...) handler from index.ts.
    const uploadsRoot = path.resolve(path.join(serveDir, 'uploads'));
    const noImageSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

    function buildServeApp(authed: boolean) {
      const app = express();
      // Inline auth middleware — no module mocking needed.
      const authMiddleware = authed
        ? (_req: Request, _res: Response, next: NextFunction) => next()
        : (_req: Request, res: Response) => void res.status(401).json({ error: 'Unauthorized' });
      app.use('/uploads', authMiddleware, (req: Request, res: Response) => {
        const relPath = req.path.replace(/^\//, '');
        if (!relPath) {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.send(noImageSvg);
          return;
        }
        const target = path.resolve(path.join(serveDir, 'uploads', relPath));
        if (!target.startsWith(uploadsRoot + path.sep)) {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.send(noImageSvg);
          return;
        }
        res.sendFile(target, (err) => {
          if (err) { res.setHeader('Content-Type', 'image/svg+xml'); res.send(noImageSvg); }
        });
      });
      return app;
    }

    authedServer = buildServeApp(true).listen(0);
    unauthServer = buildServeApp(false).listen(0);
    await Promise.all([
      new Promise<void>((r) => authedServer!.once('listening', r)),
      new Promise<void>((r) => unauthServer!.once('listening', r)),
    ]);
    authedBase = `http://127.0.0.1:${(authedServer.address() as AddressInfo).port}`;
    unauthBase = `http://127.0.0.1:${(unauthServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all([
      authedServer ? new Promise<void>((r) => authedServer!.close(() => r())) : Promise.resolve(),
      unauthServer ? new Promise<void>((r) => unauthServer!.close(() => r())) : Promise.resolve(),
    ]);
    authedServer = null;
    unauthServer = null;
    fs.rmSync(serveDir, { recursive: true, force: true });
  });

  it('serves the file to an authenticated request', async () => {
    const res = await fetch(`${authedBase}/uploads/user-abc/photo.jpg`);
    expect(res.status).toBe(200);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${unauthBase}/uploads/user-abc/photo.jpg`);
    expect(res.status).toBe(401);
  });

  it('returns the no-image SVG for path traversal attempts', async () => {
    // URL-encoded path traversal; Express decodes before routing.
    const res = await fetch(`${authedBase}/uploads/..%2F..%2Fetc%2Fpasswd`);
    const text = await res.text();
    expect(text).toContain(NO_IMAGE_SVG_SNIP);
  });

  it('returns the no-image SVG for a missing file', async () => {
    const res = await fetch(`${authedBase}/uploads/user-abc/nonexistent.jpg`);
    const text = await res.text();
    expect(text).toContain(NO_IMAGE_SVG_SNIP);
  });
});

// ---------------------------------------------------------------------------
// Storage quota — docs/DISK-QUOTAS.md §4.1, §4.4, §7
// ---------------------------------------------------------------------------

const QUOTA_USER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_USER_ID = '66666666-7777-4888-8999-000000000000';

describe('uploads router — storage quota', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let port = 0;
  let registry: typeof import('../db/registry');
  let quota: typeof import('../lib/quota');
  let currentUser = QUOTA_USER_ID;

  const KB = 1024;

  function addUser(id: string, limit: number | null): void {
    registry.registryStmts.createUser.run({
      id,
      email: `${id}@example.com`,
      properties: JSON.stringify(limit === null ? {} : { service: { diskQuotaBytes: limit } }),
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'free',
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-uploads-quota-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.UPLOAD_MAX_SIZE_MB = '1';
    currentUser = QUOTA_USER_ID;

    vi.resetModules();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = currentUser;
        next();
      },
    }));

    registry = await import('../db/registry');
    quota = await import('../lib/quota');
    const { uploadsRouter } = await import('../routes/uploads');
    const { usageRouter } = await import('../routes/usage');
    const app = express();
    app.use('/api/uploads', uploadsRouter);
    app.use('/api/usage', usageRouter);
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
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    delete process.env.UPLOAD_MAX_SIZE_MB;
    vi.resetModules();
  });

  const post = (size: number, query = ''): Promise<Response> =>
    fetch(`${baseUrl}/api/uploads${query}`, { method: 'POST', body: buildFormData('f.bin', 'application/octet-stream', size) });

  const filesOf = (id: string): string[] => {
    try { return fs.readdirSync(path.join(tmpDir, 'uploads', id)); } catch { return []; }
  };
  const usedOf = (id: string): number => quota.listUsageByUser().get(id)?.attachments ?? 0;
  const ledgerOf = (id: string) => registry.registryStmts.listAttachmentsForOwner.all(id) as {
    file_id: string; workspace_id: string; owner_user_id: string; uploader_user_id: string; size_bytes: number;
  }[];

  /** A multipart body for one file, written by hand so a test can send it as slowly as it likes. */
  function multipart(size: number): { head: Buffer; tail: Buffer; boundary: string; length: number } {
    const boundary = '----quota-test-boundary';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { head, tail, boundary, length: head.length + size + tail.length };
  }

  /** An upload held open: its headers are sent, and the body follows when the test says. */
  function openUpload(size: number, headers: Record<string, string | number> = {}) {
    const mp = multipart(size);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/uploads',
      headers: { 'Content-Type': `multipart/form-data; boundary=${mp.boundary}`, 'Content-Length': mp.length, ...headers },
    });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
    req.write(mp.head);
    return {
      response,
      /** Send the rest and finish. */
      finish: () => { req.write(Buffer.alloc(size, 'x')); req.end(mp.tail); },
      abort: () => req.destroy(),
      req,
    };
  }

  const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

  describe('the limit', () => {
    it('accepts an upload from an account with no limit, and counts it', async () => {
      addUser(QUOTA_USER_ID, null);
      const res = await post(10 * KB);
      expect(res.status).toBe(201);
      expect(usedOf(QUOTA_USER_ID)).toBe(10 * KB);
      expect(ledgerOf(QUOTA_USER_ID)).toHaveLength(1);
    });

    it('accepts uploads that fit and refuses the one that does not, with the 413 a client can read', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      expect((await post(40 * KB)).status).toBe(201);
      expect((await post(40 * KB)).status).toBe(201);
      expect(usedOf(QUOTA_USER_ID)).toBe(80 * KB);

      const res = await post(40 * KB);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: 'storage_quota_exceeded', message: expect.any(String), used: 80 * KB, limit: 100 * KB,
      });
      // The refused file is nowhere: not on the disk, not in the ledger, not in the count.
      expect(filesOf(QUOTA_USER_ID)).toHaveLength(2);
      expect(ledgerOf(QUOTA_USER_ID)).toHaveLength(2);
      expect(usedOf(QUOTA_USER_ID)).toBe(80 * KB);
    });

    it('refuses on the declared size without reading the file', async () => {
      addUser(QUOTA_USER_ID, 10 * KB);
      // Headers announcing 5 MB, and a body that never comes: the answer must not wait for it.
      const up = openUpload(1, { 'Content-Length': 5 * 1024 * KB });
      const { status } = await up.response;
      expect(status).toBe(413);
      up.abort();
      expect(filesOf(QUOTA_USER_ID)).toHaveLength(0);
    });

    it('cuts a stream of unknown length at what the account has left', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      expect((await post(60 * KB)).status).toBe(201);
      const mp = multipart(80 * KB);
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/uploads',
        headers: { 'Content-Type': `multipart/form-data; boundary=${mp.boundary}`, 'Transfer-Encoding': 'chunked' },
      });
      const done = new Promise<number>((resolve) => {
        req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', () => resolve(0));
      });
      req.write(mp.head);
      req.write(Buffer.alloc(80 * KB, 'x'));
      req.end(mp.tail);
      expect(await done).toBe(413);
      await settle();
      expect(filesOf(QUOTA_USER_ID)).toHaveLength(1);
      expect(usedOf(QUOTA_USER_ID)).toBe(60 * KB);
    });

    it('accepts a limit of zero as no room at all', async () => {
      addUser(QUOTA_USER_ID, 0);
      expect((await post(1)).status).toBe(413);
    });

    it('does not let one account\'s files use up another\'s room', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      addUser(OTHER_USER_ID, null);
      currentUser = OTHER_USER_ID;
      expect((await post(500 * KB)).status).toBe(201);
      currentUser = QUOTA_USER_ID;
      expect((await post(90 * KB)).status).toBe(201);
    });

    it('measures an account that has never been measured, so the limit is not checked against nothing', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      fs.mkdirSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'old.enc'), Buffer.alloc(90 * KB));
      expect(quota.listUsageByUser().has(QUOTA_USER_ID)).toBe(false);
      expect((await post(20 * KB)).status).toBe(413);
    });

    it('counts everything an account holds, not only the upload that first measured it', async () => {
      addUser(QUOTA_USER_ID, null);
      fs.mkdirSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'old.enc'), Buffer.alloc(90 * KB));
      expect(quota.listUsageByUser().has(QUOTA_USER_ID)).toBe(false);

      expect((await post(10 * KB)).status).toBe(201);
      expect(usedOf(QUOTA_USER_ID)).toBe(100 * KB);
      expect(ledgerOf(QUOTA_USER_ID)).toHaveLength(2);
    });

    it('does not refuse a file that fits because of the framing around it', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      // The body is a few hundred bytes more than the file: boundaries and part headers.
      const res = await post(100 * KB - 100);
      expect(res.status).toBe(201);
      expect(usedOf(QUOTA_USER_ID)).toBe(100 * KB - 100);
      // And one that really does not fit is still refused.
      expect((await post(2 * KB)).status).toBe(413);
    });

    it('still applies the per-type size limit, with the old 400', async () => {
      addUser(QUOTA_USER_ID, 100 * 1024 * KB);
      const res = await post(2 * 1024 * KB);
      expect(res.status).toBe(400);
      expect(usedOf(QUOTA_USER_ID)).toBe(0);
    });
  });

  describe('promises for uploads in flight', () => {
    it('lets exactly one of two parallel uploads through when together they do not fit', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      const first = openUpload(70 * KB);           // promises ~70 KB and keeps streaming
      await settle();
      const second = await post(70 * KB);           // would fit alone, not beside the first
      expect(second.status).toBe(413);

      first.finish();
      expect((await first.response).status).toBe(201);
      expect(usedOf(QUOTA_USER_ID)).toBe(70 * KB);
    });

    it('gives the room back when an upload is abandoned', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      const first = openUpload(70 * KB);
      await settle();
      first.abort();
      await first.response.catch(() => undefined);
      await settle(150);
      expect((await post(70 * KB)).status).toBe(201);
    });

    it('gives the room back when an upload fails its type limit', async () => {
      addUser(QUOTA_USER_ID, 3 * 1024 * KB);
      // 1 MB is the generic cap in this suite: a 1.5 MB file is refused after it streamed.
      expect((await post(1536 * KB)).status).toBe(400);
      expect((await post(1000 * KB)).status).toBe(201);
      expect((await post(1000 * KB)).status).toBe(201);
    });
  });

  describe('the workspace', () => {
    const WS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const addKey = (workspaceId: string, userId: string) =>
      registry.registryStmts.insertWorkspaceKey.run({ workspace_id: workspaceId, user_id: userId, wrapped_key: 'k', granted_at: Date.now() });

    it('is recorded with the upload, and the uploader is the owner', async () => {
      addUser(QUOTA_USER_ID, null);
      addKey(WS, QUOTA_USER_ID);
      expect((await post(KB, `?workspaceId=${WS}`)).status).toBe(201);
      expect(ledgerOf(QUOTA_USER_ID)).toEqual([
        { file_id: expect.any(String), workspace_id: WS, owner_user_id: QUOTA_USER_ID, uploader_user_id: QUOTA_USER_ID, size_bytes: KB },
      ]);
    });

    it('is accepted when nobody has a key for it yet', async () => {
      addUser(QUOTA_USER_ID, null);
      expect((await post(KB, `?workspaceId=${WS}`)).status).toBe(201);
      expect(ledgerOf(QUOTA_USER_ID)[0].workspace_id).toBe(WS);
    });

    it('is refused when it has members and the caller is not one', async () => {
      addUser(QUOTA_USER_ID, null);
      addUser(OTHER_USER_ID, null);
      addKey(WS, OTHER_USER_ID);
      const res = await post(KB, `?workspaceId=${WS}`);
      expect(res.status).toBe(403);
      expect(filesOf(QUOTA_USER_ID)).toHaveLength(0);
    });

    it('is refused when it is not an id', async () => {
      addUser(QUOTA_USER_ID, null);
      expect((await post(KB, `?workspaceId=${encodeURIComponent('../../x')}`)).status).toBe(400);
    });

    it('is empty for an upload that names none', async () => {
      addUser(QUOTA_USER_ID, null);
      await post(KB);
      expect(ledgerOf(QUOTA_USER_ID)[0].workspace_id).toBe('');
    });
  });

  describe('DELETE /api/uploads/:fileId', () => {
    const fileIdOf = (url: string) => url.split('/').pop()!;
    const del = (id: string) => fetch(`${baseUrl}/api/uploads/${id}`, { method: 'DELETE' });

    it('removes the file and the ledger row and gives the bytes back', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      const { url } = await (await post(60 * KB)).json() as { url: string };
      expect(usedOf(QUOTA_USER_ID)).toBe(60 * KB);

      expect((await del(fileIdOf(url))).status).toBe(204);
      expect(filesOf(QUOTA_USER_ID)).toHaveLength(0);
      expect(ledgerOf(QUOTA_USER_ID)).toHaveLength(0);
      expect(usedOf(QUOTA_USER_ID)).toBe(0);
      // The room is usable again.
      expect((await post(90 * KB)).status).toBe(201);
    });

    it('is 404 the second time, and for a file that was never there', async () => {
      addUser(QUOTA_USER_ID, null);
      const { url } = await (await post(KB)).json() as { url: string };
      expect((await del(fileIdOf(url))).status).toBe(204);
      expect((await del(fileIdOf(url))).status).toBe(404);
      expect((await del('nothing.bin')).status).toBe(404);
    });

    it('cannot reach another account\'s file', async () => {
      addUser(QUOTA_USER_ID, null);
      addUser(OTHER_USER_ID, null);
      currentUser = OTHER_USER_ID;
      const { url } = await (await post(KB)).json() as { url: string };
      currentUser = QUOTA_USER_ID;
      expect((await del(fileIdOf(url))).status).toBe(404);
      expect(filesOf(OTHER_USER_ID)).toHaveLength(1);
      expect(usedOf(OTHER_USER_ID)).toBe(KB);
    });

    it('refuses an id that could name a path', async () => {
      addUser(QUOTA_USER_ID, null);
      expect((await del('..%2F..%2Fregistry.db')).status).toBe(400);
      expect((await del('.hidden')).status).toBe(400);
    });

    it('counts out a file the ledger did not know yet', async () => {
      addUser(QUOTA_USER_ID, null);
      fs.mkdirSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'old.enc'), Buffer.alloc(50 * KB));
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'keep.enc'), Buffer.alloc(7 * KB));
      quota.reconcileUserUsage(QUOTA_USER_ID);
      registry.registryStmts.deleteAttachment.run(QUOTA_USER_ID, 'old.enc'); // the ledger lost it
      expect((await del('old.enc')).status).toBe(204);
      expect(usedOf(QUOTA_USER_ID)).toBe(7 * KB);
    });
  });

  describe('GET /api/uploads', () => {
    const list = async () => (await (await fetch(`${baseUrl}/api/uploads`)).json()) as { files: { id: string; size: number; workspaceId: string }[] };

    it('lists the account\'s own files, by the name they have in its folder', async () => {
      addUser(QUOTA_USER_ID, null);
      const a = await (await post(3 * KB, '?workspaceId=ws-a')).json() as { url: string };
      const b = await (await post(5 * KB)).json() as { url: string };
      const files = (await list()).files;
      expect(files).toHaveLength(2);
      expect(files.find((f) => f.id === a.url.split('/').pop())).toEqual({ id: a.url.split('/').pop(), size: 3 * KB, workspaceId: 'ws-a' });
      expect(files.find((f) => f.id === b.url.split('/').pop())).toMatchObject({ size: 5 * KB, workspaceId: '' });
    });

    it('is empty for an account with no files, and does not list another\'s', async () => {
      addUser(QUOTA_USER_ID, null);
      addUser(OTHER_USER_ID, null);
      expect((await list()).files).toEqual([]);
      currentUser = OTHER_USER_ID;
      await post(KB);
      currentUser = QUOTA_USER_ID;
      expect((await list()).files).toEqual([]);
    });

    it('lists files an account held before anything measured it', async () => {
      addUser(QUOTA_USER_ID, null);
      fs.mkdirSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'old.enc'), Buffer.alloc(7 * KB));
      expect((await list()).files).toEqual([{ id: 'old.enc', size: 7 * KB, workspaceId: '' }]);
    });

    it('no longer lists a file that was deleted', async () => {
      addUser(QUOTA_USER_ID, null);
      const { url } = await (await post(KB)).json() as { url: string };
      await fetch(`${baseUrl}/api/uploads/${url.split('/').pop()}`, { method: 'DELETE' });
      expect((await list()).files).toEqual([]);
    });
  });

  describe('GET /api/usage', () => {
    it('reports what is stored and the limit', async () => {
      addUser(QUOTA_USER_ID, 100 * KB);
      await post(30 * KB);
      const body = await (await fetch(`${baseUrl}/api/usage`)).json();
      expect(body).toEqual({ attachments: { used: 30 * KB, limit: 100 * KB }, sync: { used: 0, limit: null } });
    });

    it('reports no limit for an account that has none, and measures one it has not yet', async () => {
      addUser(QUOTA_USER_ID, null);
      fs.mkdirSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', QUOTA_USER_ID, 'a.enc'), Buffer.alloc(9 * KB));
      const body = await (await fetch(`${baseUrl}/api/usage`)).json();
      expect(body).toEqual({ attachments: { used: 9 * KB, limit: null }, sync: { used: 0, limit: null } });
    });
  });
});
