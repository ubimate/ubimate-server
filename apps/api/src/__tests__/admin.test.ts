// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for the admin REST API (non-invitation routes).
 *
 * POST /api/admin/login        — issues an admin JWT
 * GET  /api/admin/me           — returns admin identity
 * GET  /api/admin/users        — lists registered users with disk usage
 * DELETE /api/admin/users/:id  — deletes a user and writes a tombstone
 * PATCH /api/admin/users/:id/service — sets or clears the user's attachment quota
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin router', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let adminToken = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-admin-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.ADMIN_USERNAME = 'testadmin';
    process.env.ADMIN_PASSWORD = 'testpass';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.NODE_ENV = 'test';

    vi.resetModules();

    const [{ adminRouter }, { closeRegistryDb }] = await Promise.all([
      import('../routes/admin'),
      import('../db/registry'),
    ]);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', adminRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb = closeRegistryDb;

    // Ensure the users subdirectory exists (needed for tombstone writes on delete)
    fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });

    // Log in once and reuse the token for all tests in this suite
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'testpass' }),
    });
    const loginBody = await loginRes.json() as { token: string };
    adminToken = loginBody.token;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const closeRegistryDb = (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb;
      closeRegistryDb?.();
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_EMAIL;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // POST /api/admin/login
  // ---------------------------------------------------------------------------

  it('issues a JWT for valid admin credentials', async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'testpass' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // valid JWT shape
  });

  it('rejects wrong password with 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'wrongpass' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects wrong username with 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'notadmin', password: 'testpass' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when username or password is missing', async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin' }),
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/me
  // ---------------------------------------------------------------------------

  it('returns admin identity for a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { username: string; email: string };
    expect(body.username).toBe('testadmin');
    expect(body.email).toBe('admin@example.com');
  });

  it('returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/me`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-admin JWT', async () => {
    const jwt = await import('jsonwebtoken');
    const userToken = jwt.sign({ sub: randomUUID(), email: 'user@example.com' }, 'test-jwt-secret', { expiresIn: '1h' });
    const res = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/users
  // ---------------------------------------------------------------------------

  it('returns an empty array when no users are registered', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('lists registered users with expected fields', async () => {
    const { registryStmts } = await import('../db/registry');
    const userId = randomUUID();
    registryStmts.createUser.run({
      id: userId,
      email: 'alice@example.com',
      properties: JSON.stringify({ name: 'Alice' }),
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'free',
    });

    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; email: string; properties: { name: string }; status: string; disk_usage_bytes: number }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(userId);
    expect(body[0].email).toBe('alice@example.com');
    expect(body[0].properties.name).toBe('Alice');
    expect(body[0].status).toBe('active');
    expect(typeof body[0].disk_usage_bytes).toBe('number');
  });

  it('returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`);
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/admin/users/:id
  // ---------------------------------------------------------------------------

  it('deletes a user and returns 204', async () => {
    const { registryStmts } = await import('../db/registry');
    const userId = randomUUID();
    registryStmts.createUser.run({
      id: userId,
      email: 'bob@example.com',
      properties: '{}',
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'free',
    });

    const res = await fetch(`${baseUrl}/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(204);

    // User should no longer appear in the list
    const listRes = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const list = await listRes.json() as { id: string }[];
    expect(list.find((u) => u.id === userId)).toBeUndefined();
  });

  it('writes a tombstone file when a user is deleted', async () => {
    const { registryStmts } = await import('../db/registry');
    const userId = randomUUID();
    registryStmts.createUser.run({
      id: userId,
      email: 'carol@example.com',
      properties: '{}',
      created_at: Date.now(),
      status: 'active',
      public_key: null,
      wrapped_content_key: null,
      user_type: 'free',
    });

    await fetch(`${baseUrl}/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const tombstonePath = path.join(tmpDir, 'users', `${userId}_tombstone.json`);
    expect(fs.existsSync(tombstonePath)).toBe(true);
    const tombstone = JSON.parse(fs.readFileSync(tombstonePath, 'utf8')) as { email: string; deleted_at: number };
    expect(tombstone.email).toBe('carol@example.com');
    expect(typeof tombstone.deleted_at).toBe('number');
  });

  it('returns 404 when deleting a non-existent user', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users/${randomUUID()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Storage quota — docs/DISK-QUOTAS.md §6
  // ---------------------------------------------------------------------------

  describe('storage quota', () => {
    async function addUser(properties: unknown = {}): Promise<string> {
      const { registryStmts } = await import('../db/registry');
      const id = randomUUID();
      registryStmts.createUser.run({
        id,
        email: `${id}@example.com`,
        properties: typeof properties === 'string' ? properties : JSON.stringify(properties),
        created_at: Date.now(),
        status: 'active',
        public_key: null,
        wrapped_content_key: null,
        user_type: 'free',
      });
      return id;
    }

    const patch = (id: string, body: unknown, token: string | null = adminToken) =>
      fetch(`${baseUrl}/api/admin/users/${id}/service`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });

    const listed = async (id: string) => {
      const res = await fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const users = await res.json() as {
        id: string; properties: Record<string, unknown>;
        quota_bytes: number | null; attachments_used_bytes: number | null; sync_used_bytes: number | null;
      }[];
      return users.find((u) => u.id === id)!;
    };

    it('lists an account with no limit as unlimited and not yet measured', async () => {
      const id = await addUser();
      const u = await listed(id);
      expect(u.quota_bytes).toBeNull();
      expect(u.attachments_used_bytes).toBeNull();
      expect(u.sync_used_bytes).toBeNull();
    });

    it('lists the limit and the reconciled usage', async () => {
      const id = await addUser({ service: { diskQuotaBytes: 1000 } });
      fs.mkdirSync(path.join(tmpDir, 'uploads', id), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', id, 'a.enc'), Buffer.alloc(300));
      const { reconcileUserUsage } = await import('../lib/quota');
      reconcileUserUsage(id);

      const u = await listed(id);
      expect(u.quota_bytes).toBe(1000);
      expect(u.attachments_used_bytes).toBe(300);
      expect(u.sync_used_bytes).toBe(0);
    });

    it('sets the limit, and the account lists with it', async () => {
      const id = await addUser({ name: 'Alice' });
      const res = await patch(id, { diskQuotaBytes: 10737418240 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ quota_bytes: 10737418240 });

      const u = await listed(id);
      expect(u.quota_bytes).toBe(10737418240);
      expect(u.properties).toEqual({ name: 'Alice', service: { diskQuotaBytes: 10737418240 } });
    });

    it('keeps the rest of properties and of service when it changes the limit', async () => {
      const id = await addUser({ name: 'Alice', theme: 'dark', service: { diskQuotaBytes: 5, other: 'kept' } });
      expect((await patch(id, { diskQuotaBytes: 9 })).status).toBe(200);
      expect((await listed(id)).properties).toEqual({ name: 'Alice', theme: 'dark', service: { diskQuotaBytes: 9, other: 'kept' } });
    });

    it('removes the limit with null, and the account is unlimited again', async () => {
      const id = await addUser({ name: 'Alice', service: { diskQuotaBytes: 5 } });
      const res = await patch(id, { diskQuotaBytes: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ quota_bytes: null });
      const u = await listed(id);
      expect(u.quota_bytes).toBeNull();
      expect(u.properties).toEqual({ name: 'Alice' });
    });

    it('accepts a limit of zero', async () => {
      const id = await addUser();
      expect((await patch(id, { diskQuotaBytes: 0 })).status).toBe(200);
      expect((await listed(id)).quota_bytes).toBe(0);
    });

    it('refuses a value that is not a number of at least zero, and changes nothing', async () => {
      const id = await addUser({ service: { diskQuotaBytes: 5 } });
      for (const bad of [-1, '10GB', true, [], {}, undefined]) {
        const res = await patch(id, { diskQuotaBytes: bad });
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
      expect((await patch(id, {})).status).toBe(400);
      expect((await listed(id)).quota_bytes).toBe(5);
    });

    it('returns 404 for an account that does not exist', async () => {
      expect((await patch(randomUUID(), { diskQuotaBytes: 5 })).status).toBe(404);
    });

    it('refuses to rewrite properties it cannot read, and leaves them as they were', async () => {
      const id = await addUser('this is not json');
      const res = await patch(id, { diskQuotaBytes: 5 });
      expect(res.status).toBe(409);
      const { registryStmts } = await import('../db/registry');
      expect((registryStmts.getUserById.get(id) as { properties: string }).properties).toBe('this is not json');
    });

    it('refuses a request without an admin token, and a user token', async () => {
      const id = await addUser();
      expect((await patch(id, { diskQuotaBytes: 5 }, null)).status).toBe(401);
      const jwt = await import('jsonwebtoken');
      const userToken = jwt.sign({ sub: id, email: 'user@example.com' }, 'test-jwt-secret', { expiresIn: '1h' });
      expect((await patch(id, { diskQuotaBytes: 5 }, userToken)).status).toBe(401);
      expect((await listed(id)).quota_bytes).toBeNull();
    });
  });
});
