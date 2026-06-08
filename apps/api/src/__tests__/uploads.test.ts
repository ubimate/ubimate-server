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
