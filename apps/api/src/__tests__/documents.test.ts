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
// A length that would have exceeded the (now-removed) server-side content cap.
const LONG_TITLE_LEN = 4_001;

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

  it('stores and returns encrypted `properties` envelopes verbatim (zero-knowledge)', async () => {
    // The zero-knowledge contract: the server persists the opaque `{ _enc }`
    // ciphertext envelope byte-for-byte and never inspects or rewrites it.
    const envelope = { _enc: Buffer.from('cipher-bytes-\u{1F512}').toString('base64') };
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'image', position: 'a0', properties: envelope }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string };

    const got = await fetch(`${baseUrl}/api/documents/${created.id}`);
    const body = await got.json() as { properties: Record<string, unknown> };
    expect(body.properties).toEqual(envelope);
    expect(Object.keys(body.properties)).toEqual(['_enc']);
  });

  it('applies long-property create operations in structural sync (no content cap)', async () => {
    const longTitle = 'x'.repeat(LONG_TITLE_LEN);
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
            payload: { type: 'page', parent_id: null, properties: { title: longTitle } },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; skipped: number; documents: Array<{ id: string }> };
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.documents.find((d) => d.id === noteId)).toBeDefined();
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

  // ---------------------------------------------------------------------------
  // Cross-workspace move guard (docs/KEY-PER-WORKSPACE.md §8)
  // ---------------------------------------------------------------------------

  /** POST /api/documents under a specific parent; returns the created doc id. */
  async function createChildDoc(
    type: string,
    parentId: string | null,
    properties: Record<string, unknown> = { _enc: 'x' },
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, parent_id: parentId, position: 'a0', properties }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string };
    return body.id;
  }

  it('rejects repositioning a page into a different workspace', async () => {
    const wsA = await createChildDoc('workspace', null);
    const wsB = await createChildDoc('workspace', null);
    const pageId = await createChildDoc('page', wsA);

    const res = await fetch(`${baseUrl}/api/documents/${pageId}/reposition`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: wsB, before_id: null, client_ts: Date.now() + 10_000 }),
    });
    expect(res.status).toBe(409);

    // The page must remain in workspace A.
    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(wsA);
  });

  it('allows repositioning a page within the same workspace', async () => {
    const wsA = await createChildDoc('workspace', null);
    const folderId = await createChildDoc('folder', wsA);
    const pageId = await createChildDoc('page', wsA);

    const res = await fetch(`${baseUrl}/api/documents/${pageId}/reposition`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: folderId, before_id: null, client_ts: Date.now() + 10_000 }),
    });
    expect(res.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(folderId);
  });

  it('skips a cross-workspace reposition op during structural sync', async () => {
    const wsA = await createChildDoc('workspace', null);
    const wsB = await createChildDoc('workspace', null);
    const pageId = await createChildDoc('page', wsA);

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [
          {
            op: 'reposition',
            id: pageId,
            client_ts: Date.now() + 10_000,
            payload: { parent_id: wsB },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; skipped: number };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);

    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(wsA);
  });

  it('rejects moving a deeply-nested page out of its workspace (walks the ancestor chain)', async () => {
    // wsA › folder › page  →  attempt to move `page` under wsB.
    // The source workspace must be resolved by walking parents past the folder,
    // not read from the page's direct parent.
    const wsA = await createChildDoc('workspace', null);
    const wsB = await createChildDoc('workspace', null);
    const folderId = await createChildDoc('folder', wsA);
    const pageId = await createChildDoc('page', folderId);

    const res = await fetch(`${baseUrl}/api/documents/${pageId}/reposition`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: wsB, before_id: null, client_ts: Date.now() + 10_000 }),
    });
    expect(res.status).toBe(409);

    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(folderId);
  });

  it('rejects moving a page into a sub-folder of another workspace', async () => {
    // Destination is a folder nested inside wsB — the guard must resolve the
    // destination workspace by walking up from the new parent, not assume the
    // new parent is itself a workspace.
    const wsA = await createChildDoc('workspace', null);
    const wsB = await createChildDoc('workspace', null);
    const folderInB = await createChildDoc('folder', wsB);
    const pageId = await createChildDoc('page', wsA);

    const res = await fetch(`${baseUrl}/api/documents/${pageId}/reposition`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: folderInB, before_id: null, client_ts: Date.now() + 10_000 }),
    });
    expect(res.status).toBe(409);

    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(wsA);
  });

  it('allows reordering a workspace node at the root (guard bypasses workspace-type nodes)', async () => {
    const wsA = await createChildDoc('workspace', null);
    const wsB = await createChildDoc('workspace', null);

    // Reposition wsB to the front of the root list (parent stays null). The
    // cross-workspace guard must not fire for a workspace node itself.
    const res = await fetch(`${baseUrl}/api/documents/${wsB}/reposition`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: null, before_id: wsA, client_ts: Date.now() + 10_000 }),
    });
    expect(res.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/documents/${wsB}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBeNull();
  });

  it('applies a same-workspace reposition op during structural sync', async () => {
    const wsA = await createChildDoc('workspace', null);
    const folderId = await createChildDoc('folder', wsA);
    const pageId = await createChildDoc('page', wsA);

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ops: [
          {
            op: 'reposition',
            id: pageId,
            client_ts: Date.now() + 10_000,
            payload: { parent_id: folderId },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; skipped: number };
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(0);

    const after = await fetch(`${baseUrl}/api/documents/${pageId}`);
    const doc = await after.json() as { parent_id: string | null };
    expect(doc.parent_id).toBe(folderId);
  });
});
