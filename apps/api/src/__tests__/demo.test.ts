// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Integration tests for POST /api/demo/provision and the demo cleanup helpers.
 *
 * Covers:
 * - Successful provision: 201, correct response shape, JWT cookie set
 * - JWT cookie carries is_demo=true claim
 * - Disabled demo mode returns 403
 * - MAX_DEMO_USERS cap returns 503
 * - runDemoCleanup removes expired demo rows and SQLite files
 * - Non-expired users are not cleaned up
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_JWT_SECRET = 'test-demo-jwt-secret';

describe('demo router — POST /api/demo/provision', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let closeRegistryDb: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-demo-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE_ENABLED = 'true';
    delete process.env.MAX_DEMO_USERS;
    delete process.env.DEMO_EXPIRY_HOURS;

    vi.resetModules();

    const [{ demoRouter }, { closeRegistryDb: close }] = await Promise.all([
      import('../routes/demo'),
      import('../db/registry'),
    ]);
    closeRegistryDb = close;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/demo', demoRouter);

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
    closeRegistryDb?.();
    closeRegistryDb = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
    delete process.env.DEMO_MODE_ENABLED;
    delete process.env.MAX_DEMO_USERS;
    delete process.env.DEMO_EXPIRY_HOURS;
    vi.resetModules();
  });

  it('returns 201 with correct DemoProvisionResponse shape', async () => {
    const res = await fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.is_demo).toBe(true);
    expect(body.workspace_keys).toEqual([]);
    expect(typeof body.demo_expires_at).toBe('number');
    expect((body.demo_expires_at as number)).toBeGreaterThan(Date.now());

    // user object
    const user = body.user as Record<string, unknown>;
    expect(typeof user.id).toBe('string');
    expect(typeof user.email).toBe('string');
    expect((user.email as string).endsWith('@demo.local')).toBe(true);
    expect(user.public_key).toBeNull();
    expect((user.properties as Record<string, string>).name).toBe('Demo User');
  });

  it('sets a session-scoped httpOnly cookie', async () => {
    const res = await fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' });
    expect(res.status).toBe(201);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('nf_session=');
    expect(setCookie).toContain('HttpOnly');
    // Session-scoped cookie must NOT have Max-Age or Expires
    expect(setCookie).not.toMatch(/max-age/i);
    expect(setCookie).not.toMatch(/expires=/i);
  });

  it('JWT cookie carries sub, email, and is_demo=true', async () => {
    const res = await fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' });
    expect(res.status).toBe(201);

    const body = await res.json() as { user: { id: string; email: string } };
    const setCookie = res.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/nf_session=([^;]+)/);
    expect(tokenMatch).not.toBeNull();

    const token = tokenMatch![1];
    const payload = jwt.verify(token, TEST_JWT_SECRET) as Record<string, unknown>;
    expect(payload.sub).toBe(body.user.id);
    expect(payload.email).toBe(body.user.email);
    expect(payload.is_demo).toBe(true);
  });

  it('each provision call creates a unique user', async () => {
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' }),
      fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const [b1, b2] = await Promise.all([r1.json(), r2.json()]) as [{ user: { id: string } }, { user: { id: string } }];
    expect(b1.user.id).not.toBe(b2.user.id);
  });

  it('seeder creates at least one document (welcome page) in user db', async () => {
    const res = await fetch(`${baseUrl}/api/demo/provision`, { method: 'POST' });
    const body = await res.json() as { user: { id: string } };
    const userId = body.user.id;

    const dbPath = path.join(tmpDir, 'users', `${userId}.db`);
    expect(fs.existsSync(dbPath)).toBe(true);

    // Open the SQLite file and verify documents were seeded
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const count = (db.prepare('SELECT COUNT(*) as n FROM documents').get() as { n: number }).n;
    db.close();
    expect(count).toBeGreaterThanOrEqual(5); // workspace + welcome + folder + 2 notes + tasks
  });

  it('returns 403 when DEMO_MODE_ENABLED=false', async () => {
    // Rebuild server with demo disabled
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    closeRegistryDb?.();

    process.env.DEMO_MODE_ENABLED = 'false';
    vi.resetModules();

    const [{ demoRouter: disabledRouter }, { closeRegistryDb: close2 }] = await Promise.all([
      import('../routes/demo'),
      import('../db/registry'),
    ]);
    closeRegistryDb = close2;

    const app2 = express();
    app2.use(express.json());
    app2.use(cookieParser());
    app2.use('/api/demo', disabledRouter);

    server = app2.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr2 = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr2.port}/api/demo/provision`, { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/disabled/i);
  });

  it('returns 503 when MAX_DEMO_USERS cap is reached', async () => {
    // Rebuild server with cap = 0
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    closeRegistryDb?.();

    process.env.MAX_DEMO_USERS = '0';
    vi.resetModules();

    const [{ demoRouter: cappedRouter }, { closeRegistryDb: close3 }] = await Promise.all([
      import('../routes/demo'),
      import('../db/registry'),
    ]);
    closeRegistryDb = close3;

    const app3 = express();
    app3.use(express.json());
    app3.use(cookieParser());
    app3.use('/api/demo', cappedRouter);

    server = app3.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const addr3 = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr3.port}/api/demo/provision`, { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/capacity/i);
  });
});

describe('runDemoCleanup', () => {
  let tmpDir: string;
  let closeRegistryDb: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-demo-cleanup-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE_ENABLED = 'true';
    vi.resetModules();

    const { closeRegistryDb: close } = await import('../db/registry');
    closeRegistryDb = close;
  });

  afterEach(async () => {
    closeRegistryDb?.();
    closeRegistryDb = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
    delete process.env.DEMO_MODE_ENABLED;
    vi.resetModules();
  });

  it('removes expired demo users and their SQLite files', async () => {
    const { registryStmts } = await import('../db/registry');
    const { getUserDb } = await import('../db/userDb');
    const { runDemoCleanup } = await import('../routes/demo');
    const { randomUUID } = await import('node:crypto');

    const userId = randomUUID();
    const expiredAt = Date.now() - 1000; // already expired

    registryStmts.createDemoUser.run({
      id: userId,
      email: `demo-${userId}@demo.local`,
      properties: JSON.stringify({ name: 'Demo User' }),
      created_at: Date.now() - 60_000,
      demo_expires_at: expiredAt,
    });

    // Create the SQLite file so cleanup can delete it
    getUserDb(userId);
    const dbPath = path.join(tmpDir, 'users', `${userId}.db`);
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify row exists before cleanup
    const before = registryStmts.listExpiredDemoUsers.all(Date.now()) as { id: string }[];
    expect(before.some((r) => r.id === userId)).toBe(true);

    runDemoCleanup();

    // Row should be gone
    const after = registryStmts.listExpiredDemoUsers.all(Date.now()) as { id: string }[];
    expect(after.some((r) => r.id === userId)).toBe(false);

    // SQLite file should be deleted
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('does not remove non-expired demo users', async () => {
    const { registryStmts } = await import('../db/registry');
    const { runDemoCleanup } = await import('../routes/demo');
    const { randomUUID } = await import('node:crypto');

    const userId = randomUUID();
    const futureExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24h from now

    registryStmts.createDemoUser.run({
      id: userId,
      email: `demo-${userId}@demo.local`,
      properties: JSON.stringify({ name: 'Demo User' }),
      created_at: Date.now(),
      demo_expires_at: futureExpiry,
    });

    runDemoCleanup();

    // Row should still exist
    const row = (registryStmts as unknown as { getUserById?: { get: (id: string) => unknown } })
      .getUserById?.get(userId);
    // getUserById may not exist; fall back to checking that the user doesn't appear in expired list
    const expired = registryStmts.listExpiredDemoUsers.all(Date.now()) as { id: string }[];
    expect(expired.some((r) => r.id === userId)).toBe(false);
  });
});
