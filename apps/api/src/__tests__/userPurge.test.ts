// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Deleting an account (DELETE /api/admin/users/:id → lib/userPurge.ts, docs/ADMIN.md §2.7): everything the
 * server holds for it goes, a bucket object first, and nothing goes when a bucket object will not.
 * Also: a token of a deleted account no longer authenticates (middleware/auth.ts).
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Registry = typeof import('../db/registry');

const USER = 'user-to-delete';
const OTHER = 'someone-else';
const OWN_SPACE = 'space-of-user';
const SHARED_SPACE = 'space-shared-with-other';

class FakeBucket {
  deleted: string[] = [];
  failOn: string | null = null;
  async presignPut(): Promise<{ url: string; headers: Record<string, string> }> { throw new Error('unused'); }
  async presignGet(): Promise<string> { throw new Error('unused'); }
  async head(): Promise<number | null> { return null; }
  async delete(key: string): Promise<void> {
    if (key === this.failOn) throw new Error('bucket unavailable');
    this.deleted.push(key);
  }
}

describe('deleting a user purges their data', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let adminToken = '';
  let registry: Registry;
  let bucket: FakeBucket;

  let registryRaw: import('better-sqlite3').Database;
  const count = (sql: string, ...args: unknown[]): number => (registryRaw.prepare(sql).get(...args) as { n: number }).n;

  function attachment(id: string, storage: 'local' | 's3', owner = USER, workspace = OWN_SPACE): void {
    registry.registryStmts.insertPendingAttachment.run({
      attachment_id: id, workspace_id: workspace, uploader_user_id: owner, owner_user_id: owner, kind: 'image',
      storage, storage_key: storage === 's3' ? `a/${id}` : `${owner}/${id}`, key_version: 1, wrapped_key: 'w',
      expected_size: 10, created_at: Date.now(),
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-purge-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.ADMIN_USERNAME = 'testadmin';
    process.env.ADMIN_PASSWORD = 'testpass';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.NODE_ENV = 'test';
    vi.resetModules();

    registry = await import('../db/registry');
    const Database = (await import('better-sqlite3')).default;
    registryRaw = new Database(path.join(tmpDir, 'registry.db'));
    bucket = new FakeBucket();
    (await import('../lib/objectStore')).setObjectStoreForTests(bucket);

    const { adminRouter } = await import('../routes/admin');
    const { requireAuth } = await import('../middleware/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', adminRouter);
    app.get('/api/whoami', requireAuth, (req, res) => { res.json({ id: req.userId }); });
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'testpass' }),
    });
    adminToken = ((await login.json()) as { token: string }).token;

    const s = registry.registryStmts;
    for (const id of [USER, OTHER]) {
      s.createUser.run({ id, email: `${id}@example.com`, properties: '{}', created_at: Date.now(), status: 'active',
        public_key: null, wrapped_content_key: null, user_type: 'free' });
    }
    const key = (ws: string, u: string) => s.insertWorkspaceKey.run({ workspace_id: ws, user_id: u, wrapped_key: 'k', granted_at: 1 });
    key(OWN_SPACE, USER); key(SHARED_SPACE, USER); key(SHARED_SPACE, OTHER);
    s.recordSpaceOwner.run({ workspace_id: OWN_SPACE, owner_user_id: USER });
    s.recordSpaceOwner.run({ workspace_id: SHARED_SPACE, owner_user_id: USER });
    registryRaw.prepare(`INSERT INTO workspace_key_chain (workspace_id, key_version, wrapped_previous, created_at) VALUES (?, 2, 'p', 1)`).run(OWN_SPACE);
    s.setUsedBytes.run({ user_id: USER, kind: 'attachments', used_bytes: 20, updated_at: 1 });
    attachment('local-1', 'local');
    attachment('s3-1', 's3');
    attachment('s3-2', 's3');
    attachment('others', 's3', OTHER, SHARED_SPACE);

    // The user's database (with a WAL), and an uploaded file.
    const { getUserDb, closeUserDb } = await import('../db/userDb');
    getUserDb(USER);
    closeUserDb(USER);
    fs.writeFileSync(path.join(tmpDir, 'users', `${USER}.db-wal`), '');
    fs.mkdirSync(path.join(tmpDir, 'uploads', USER), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'uploads', USER, 'local-1'), 'bytes');
  });

  afterEach(async () => {
    registryRaw.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_EMAIL', 'NODE_ENV']) delete process.env[k];
    vi.resetModules();
  });

  const del = (id: string) => fetch(`${baseUrl}/api/admin/users/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  const userFile = (name: string) => path.join(tmpDir, 'users', name);

  /** Every place the fixture put something of USER's, with how many there are. */
  function holdings() {
    return {
      user: count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, USER),
      keys: count(`SELECT COUNT(*) AS n FROM workspace_keys WHERE user_id = ?`, USER),
      ownSpaceState: count(`SELECT COUNT(*) AS n FROM workspace_key_state WHERE workspace_id = ?`, OWN_SPACE),
      ownSpaceChain: count(`SELECT COUNT(*) AS n FROM workspace_key_chain WHERE workspace_id = ?`, OWN_SPACE),
      attachments: count(`SELECT COUNT(*) AS n FROM attachments WHERE owner_user_id = ?`, USER),
      usage: count(`SELECT COUNT(*) AS n FROM usage WHERE user_id = ?`, USER),
      db: fs.existsSync(userFile(`${USER}.db`)),
      wal: fs.existsSync(userFile(`${USER}.db-wal`)),
      uploads: fs.existsSync(path.join(tmpDir, 'uploads', USER)),
    };
  }

  it('removes the account, its keys, ledger, usage, database and uploads, and its bucket objects', async () => {
    // The precondition: the fixture really holds something in each place.
    expect(holdings()).toEqual({ user: 1, keys: 2, ownSpaceState: 1, ownSpaceChain: 1, attachments: 3, usage: 1, db: true, wal: true, uploads: true });

    expect((await del(USER)).status).toBe(204);

    expect(holdings()).toEqual({ user: 0, keys: 0, ownSpaceState: 0, ownSpaceChain: 0, attachments: 0, usage: 0, db: false, wal: false, uploads: false });
    expect(bucket.deleted.sort()).toEqual(['a/s3-1', 'a/s3-2']);
    expect(fs.existsSync(userFile(`${USER}_tombstone.json`))).toBe(true);
  });

  it('leaves what is not theirs: another member keeps a shared Space, its state, and their own attachment', async () => {
    expect((await del(USER)).status).toBe(204);

    expect(count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, OTHER)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = ? AND user_id = ?`, SHARED_SPACE, OTHER)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM workspace_key_state WHERE workspace_id = ?`, SHARED_SPACE)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM attachments WHERE attachment_id = 'others'`)).toBe(1);
    expect(bucket.deleted).not.toContain('a/others');
  });

  it('deletes nothing and answers 502 when a bucket object cannot be removed', async () => {
    bucket.failOn = 'a/s3-2';
    const before = holdings();

    const res = await del(USER);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/try again/);
    expect(holdings()).toEqual(before);
    expect(fs.existsSync(userFile(`${USER}_tombstone.json`))).toBe(false);

    // Once the bucket answers, the retry finishes the job.
    bucket.failOn = null;
    expect((await del(USER)).status).toBe(204);
    expect(holdings().user).toBe(0);
  });

  it("a deleted account's token is refused, and does not bring its database back", async () => {
    const token = jwt.sign({ sub: USER, email: `${USER}@example.com` }, 'test-jwt-secret');
    const whoami = () => fetch(`${baseUrl}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await whoami()).status).toBe(200);

    expect((await del(USER)).status).toBe(204);

    expect((await whoami()).status).toBe(401);
    expect(fs.existsSync(userFile(`${USER}.db`))).toBe(false);
  });
});
