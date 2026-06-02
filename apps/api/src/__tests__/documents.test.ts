// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for PUT /api/documents/:id — superseded upload file cleanup.
 *
 * When the `src` property on an `image` or `file` document is replaced, the
 * old server-hosted file should be deleted from disk immediately.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';

const TEST_USER_ID = 'test-user-docs';

describe('PUT /api/documents/:id — old src file cleanup', () => {
  let tmpDir: string;
  let handle: UserDbHandle;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-docs-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';

    // Create the user DB before the mock factory runs so `handle` is defined
    // by the time any request reaches the fake auth middleware.
    fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
    handle = initUserDb(path.join(tmpDir, 'users', `${TEST_USER_ID}.db`));

    vi.resetModules();

    // Replace requireAuth with a no-op that injects the test userId and handle.
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
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Create a real file in the uploads directory and return its server path. */
  function seedUploadFile(filename?: string): { filePath: string; src: string } {
    const uploadsDir = path.join(tmpDir, 'uploads', TEST_USER_ID);
    fs.mkdirSync(uploadsDir, { recursive: true });
    const fname = filename ?? `${randomUUID()}.png`;
    const filePath = path.join(uploadsDir, fname);
    fs.writeFileSync(filePath, 'fake-image-bytes');
    return { filePath, src: `/uploads/${TEST_USER_ID}/${fname}` };
  }

  /** POST /api/documents and return the created doc id. */
  async function createDoc(type: string, properties: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, position: 'a0', properties }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string };
    return body.id;
  }

  /** Wait a tick for async fs.unlink to complete. */
  const tick = () => new Promise<void>((r) => setTimeout(r, 50));

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('deletes the old file when src changes on an image document', async () => {
    const { filePath: oldFile, src: oldSrc } = seedUploadFile();
    const docId = await createDoc('image', { src: oldSrc });

    const newSrc = `/uploads/${TEST_USER_ID}/${randomUUID()}.png`;
    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: newSrc } }),
    });
    expect(res.status).toBe(200);

    await tick();
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('deletes the old file when src changes on a file document', async () => {
    const { filePath: oldFile, src: oldSrc } = seedUploadFile(`${randomUUID()}.pdf`);
    const docId = await createDoc('file', { src: oldSrc });

    const newSrc = `/uploads/${TEST_USER_ID}/${randomUUID()}.pdf`;
    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: newSrc } }),
    });
    expect(res.status).toBe(200);

    await tick();
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('does not delete the file when src is unchanged', async () => {
    const { filePath, src } = seedUploadFile();
    const docId = await createDoc('image', { src });

    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src, alt: 'updated alt text' } }),
    });
    expect(res.status).toBe(200);

    await tick();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('does not delete anything when properties are not updated', async () => {
    const { filePath, src } = seedUploadFile();
    const docId = await createDoc('image', { src });

    // PUT without a properties field — only structural change
    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'b0' }),
    });
    expect(res.status).toBe(200);

    await tick();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('does not delete when src changes on a non-media document type', async () => {
    const { filePath, src: oldSrc } = seedUploadFile();
    const docId = await createDoc('page', { src: oldSrc });

    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: `/uploads/${TEST_USER_ID}/${randomUUID()}.png` } }),
    });
    expect(res.status).toBe(200);

    await tick();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('does not attempt to delete external (non-upload) URLs', async () => {
    // No file on disk — just verifies the PUT succeeds without throwing.
    const docId = await createDoc('image', { src: 'https://example.com/old.png' });

    const res = await fetch(`${baseUrl}/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: 'https://example.com/new.png' } }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for a non-existent document', async () => {
    const res = await fetch(`${baseUrl}/api/documents/${randomUUID()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: '/uploads/x/y.png' } }),
    });
    expect(res.status).toBe(404);
  });
});
