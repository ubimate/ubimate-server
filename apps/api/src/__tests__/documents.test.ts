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
const MAX_NOTE_CHARS = 4_000;

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
    const { closeRegistryDb } = await import('../db/registry');
    closeRegistryDb();
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

  it('rejects note creation when title exceeds the note length cap', async () => {
    const tooLong = 'x'.repeat(MAX_NOTE_CHARS + 1);
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', position: 'a0', properties: { title: tooLong } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain(`max ${MAX_NOTE_CHARS} characters`);
  });

  it('skips oversize note create operations in structural sync', async () => {
    const tooLong = 'x'.repeat(MAX_NOTE_CHARS + 1);
    const noteId = randomUUID();
    const ts = Date.now();

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [
          {
            op: 'create',
            id: noteId,
            client_ts: ts,
            payload: { type: 'note', parent_id: null, properties: { title: tooLong } },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; skipped: number; documents: Array<{ id: string }> };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.documents.find((d) => d.id === noteId)).toBeUndefined();
  });

  it('persists wrappedWorkspaceKey when a workspace is created via structural sync', async () => {
    const workspaceId = randomUUID();
    const ts = Date.now();
    const wrappedKey = 'sealed-workspace-key-base64';

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [
          {
            op: 'create',
            id: workspaceId,
            client_ts: ts,
            payload: {
              type: 'workspace',
              parent_id: null,
              properties: { _enc: 'ciphertext' },
              wrappedWorkspaceKey: wrappedKey,
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number };
    expect(body.applied).toBe(1);

    const { registryStmts } = await import('../db/registry');
    const row = registryStmts.getWorkspaceKeyForUser.get(workspaceId, TEST_USER_ID) as
      | { workspace_id: string; wrapped_key: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.wrapped_key).toBe(wrappedKey);
  });

  // ---------------------------------------------------------------------------
  // Home (primary) workspace protection
  // ---------------------------------------------------------------------------

  /** Seed a registry user row for TEST_USER_ID and mark `workspaceId` as the home workspace. */
  async function seedHomeWorkspace(workspaceId: string): Promise<void> {
    const { registryStmts } = await import('../db/registry');
    const existing = registryStmts.getUserById.get(TEST_USER_ID);
    if (!existing) {
      registryStmts.createUser.run({
        id: TEST_USER_ID,
        email: 'docs@example.com',
        properties: '{}',
        created_at: Date.now(),
        status: 'active',
        public_key: null,
        wrapped_content_key: null,
        user_type: 'regular',
      });
    }
    registryStmts.setPrimaryWorkspaceId.run({ id: TEST_USER_ID, primary_workspace_id: workspaceId });
  }

  it('refuses to move the home workspace to trash', async () => {
    const wsId = await createDoc('workspace', { _enc: 'x' });
    await seedHomeWorkspace(wsId);

    const res = await fetch(`${baseUrl}/api/documents/${wsId}/trash`, { method: 'PATCH' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain('home workspace');

    // The workspace must still be active (status unchanged).
    const after = await fetch(`${baseUrl}/api/documents/${wsId}`);
    const doc = await after.json() as { status?: number };
    expect((doc.status ?? 0) & 2).toBe(0);
  });

  it('refuses to permanently delete the home workspace', async () => {
    const wsId = await createDoc('workspace', { _enc: 'x' });
    await seedHomeWorkspace(wsId);

    const res = await fetch(`${baseUrl}/api/documents/${wsId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);

    const after = await fetch(`${baseUrl}/api/documents/${wsId}`);
    expect(after.status).toBe(200);
  });

  it('skips a structural delete op that targets the home workspace', async () => {
    const wsId = await createDoc('workspace', { _enc: 'x' });
    await seedHomeWorkspace(wsId);

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [{ op: 'delete', id: wsId, client_ts: Date.now() + 10_000 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; skipped: number };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);

    const after = await fetch(`${baseUrl}/api/documents/${wsId}`);
    expect(after.status).toBe(200);
  });

  it('still allows trashing a non-home workspace', async () => {
    const homeId = await createDoc('workspace', { _enc: 'home' });
    await seedHomeWorkspace(homeId);
    const otherId = await createDoc('workspace', { _enc: 'other' });

    const res = await fetch(`${baseUrl}/api/documents/${otherId}/trash`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    const doc = await res.json() as { status?: number };
    expect((doc.status ?? 0) & 2).toBe(2);
  });
});
