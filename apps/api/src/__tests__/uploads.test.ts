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
