// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for workspace key management endpoints.
 *
 * GET /api/workspaces/:id/key          — fetch caller's wrapped key
 * PUT /api/workspaces/:id/key/:userId  — grant/update a key for another user
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = randomUUID();
const USER_B = randomUUID();
const WORKSPACE_ID = randomUUID();

describe('workspaces router', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  /** JWT token for USER_A (holds a workspace key). */
  let tokenA = '';
  /** JWT token for USER_B (no key initially). */
  let tokenB = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-ws-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NODE_ENV = 'test';

    vi.resetModules();

    const jwt = await import('jsonwebtoken');
    tokenA = jwt.sign({ sub: USER_A, email: 'a@example.com' }, 'test-jwt-secret', { expiresIn: '1h' });
    tokenB = jwt.sign({ sub: USER_B, email: 'b@example.com' }, 'test-jwt-secret', { expiresIn: '1h' });

    const { registryStmts } = await import('../db/registry');

    // Seed USER_A and USER_B in the registry
    const now = Date.now();
    for (const [id, email] of [[USER_A, 'a@example.com'], [USER_B, 'b@example.com']]) {
      registryStmts.createUser.run({
        id,
        email,
        properties: '{}',
        created_at: now,
        status: 'active',
        public_key: null,
        wrapped_content_key: null,
        user_type: 'free',
      });
    }

    // Give USER_A a workspace key
    registryStmts.insertWorkspaceKey.run({
      workspace_id: WORKSPACE_ID,
      user_id: USER_A,
      wrapped_key: 'wrapped-key-for-a',
      granted_at: now,
    });

    const { workspacesRouter } = await import('../routes/workspaces');

    const app = express();
    app.use(express.json());
    app.use('/api/workspaces', workspacesRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const { closeRegistryDb } = await import('../db/registry');
      closeRegistryDb();
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // GET /api/workspaces/:id/key
  // ---------------------------------------------------------------------------

  it('returns the wrapped key for a user who has one', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { workspace_id: string; wrapped_key: string };
    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.wrapped_key).toBe('wrapped-key-for-a');
  });

  it('returns 403 when the user has no key for the workspace', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 for an unknown workspace id', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${randomUUID()}/key`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 without an auth token', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key`);
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // PUT /api/workspaces/:id/key/:userId
  // ---------------------------------------------------------------------------

  it('allows a key-holder to grant a key to another user', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_B}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrapped_key: 'wrapped-key-for-b' }),
    });
    expect(res.status).toBe(204);

    // Verify it was stored
    const { registryStmts } = await import('../db/registry');
    const row = registryStmts.getWorkspaceKeyForUser.get(WORKSPACE_ID, USER_B) as { wrapped_key: string } | undefined;
    expect(row?.wrapped_key).toBe('wrapped-key-for-b');
  });

  it('allows updating an existing key (upsert)', async () => {
    // First grant
    await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_B}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrapped_key: 'old-key' }),
    });

    // Update
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_B}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrapped_key: 'new-key' }),
    });
    expect(res.status).toBe(204);

    const { registryStmts } = await import('../db/registry');
    const row = registryStmts.getWorkspaceKeyForUser.get(WORKSPACE_ID, USER_B) as { wrapped_key: string } | undefined;
    expect(row?.wrapped_key).toBe('new-key');
  });

  it('returns 403 when the caller has no key for the workspace', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_A}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrapped_key: 'some-key' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when wrapped_key is missing from body', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_B}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without an auth token', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE_ID}/key/${USER_B}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrapped_key: 'some-key' }),
    });
    expect(res.status).toBe(401);
  });
});
