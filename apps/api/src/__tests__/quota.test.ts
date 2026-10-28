// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Storage quotas (docs/DISK-QUOTAS.md): reading the limit from a user's properties, writing it back,
 * and reconciling usage from the disk and the user's database.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('storage quotas', () => {
  let tmpDir: string;
  let quota: typeof import('../lib/quota');
  let registry: typeof import('../db/registry');
  let userDb: typeof import('../db/userDb');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-quota-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    registry = await import('../db/registry');
    userDb = await import('../db/userDb');
    quota = await import('../lib/quota');
  });

  afterEach(() => {
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function addUser(properties: unknown = {}): string {
    const id = randomUUID();
    registry.registryStmts.createUser.run({
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

  function writeUpload(userId: string, name: string, bytes: number): void {
    const dir = path.join(tmpDir, 'uploads', userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
  }

  describe('getQuotaBytes', () => {
    const limitOf = (properties: string): number | null => quota.getQuotaBytes({ id: randomUUID(), properties });

    it('is unlimited without a service, or without a limit in it', () => {
      expect(limitOf('{}')).toBeNull();
      expect(limitOf(JSON.stringify({ name: 'A' }))).toBeNull();
      expect(limitOf(JSON.stringify({ service: {} }))).toBeNull();
      expect(limitOf(JSON.stringify({ service: null }))).toBeNull();
    });

    it('reads a valid limit, zero included', () => {
      expect(limitOf(JSON.stringify({ service: { diskQuotaBytes: 10737418240 } }))).toBe(10737418240);
      expect(limitOf(JSON.stringify({ service: { diskQuotaBytes: 0 } }))).toBe(0);
    });

    it('treats a value that is not a number of at least zero as unlimited, and says so once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = randomUUID();
      for (const bad of ['10GB', -1, null, true, [], {}]) {
        expect(quota.getQuotaBytes({ id, properties: JSON.stringify({ service: { diskQuotaBytes: bad } }) })).toBeNull();
      }
      // null is the one the JSON of NaN and Infinity comes back as.
      expect(quota.getQuotaBytes({ id: randomUUID(), properties: JSON.stringify({ service: { diskQuotaBytes: Infinity } }) })).toBeNull();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(id))).toHaveLength(1);
    });

    it('is unlimited for a service that is not an object, and for properties that are not JSON', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(limitOf(JSON.stringify({ service: 'big' }))).toBeNull();
      expect(limitOf(JSON.stringify({ service: [5] }))).toBeNull();
      expect(limitOf('not json')).toBeNull();
    });
  });

  describe('isValidQuotaBytes', () => {
    it('accepts finite numbers of at least zero and nothing else', () => {
      expect(quota.isValidQuotaBytes(0)).toBe(true);
      expect(quota.isValidQuotaBytes(1024)).toBe(true);
      for (const bad of [-1, NaN, Infinity, '5', null, undefined, {}, [], true]) {
        expect(quota.isValidQuotaBytes(bad)).toBe(false);
      }
    });
  });

  describe('withDiskQuota', () => {
    it('sets the limit and keeps every other property', () => {
      expect(quota.withDiskQuota({ name: 'A', x: { y: 1 } }, 100)).toEqual({ name: 'A', x: { y: 1 }, service: { diskQuotaBytes: 100 } });
    });

    it('keeps the rest of service when it sets or clears the limit', () => {
      const before = { service: { diskQuotaBytes: 5, other: 'kept' } };
      expect(quota.withDiskQuota(before, 9)).toEqual({ service: { diskQuotaBytes: 9, other: 'kept' } });
      expect(quota.withDiskQuota(before, null)).toEqual({ service: { other: 'kept' } });
    });

    it('drops a service it has emptied, and leaves properties without one as they were', () => {
      expect(quota.withDiskQuota({ name: 'A', service: { diskQuotaBytes: 5 } }, null)).toEqual({ name: 'A' });
      expect(quota.withDiskQuota({ name: 'A' }, null)).toEqual({ name: 'A' });
    });

    it('replaces a service that is not an object, and does not change its input', () => {
      expect(quota.withDiskQuota({ service: 'big' }, 7)).toEqual({ service: { diskQuotaBytes: 7 } });
      const input = { service: { diskQuotaBytes: 5 } };
      quota.withDiskQuota(input, 9);
      expect(input).toEqual({ service: { diskQuotaBytes: 5 } });
    });
  });

  describe('reconcileUserUsage', () => {
    const usageOf = (id: string) => quota.listUsageByUser().get(id);

    it('counts the files in the uploads directory, and records a ledger row for each', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 100);
      writeUpload(id, 'b.enc', 250);

      expect(quota.reconcileUserUsage(id)).toEqual({ attachments: 350, sync: 0 });
      expect(usageOf(id)).toEqual({ attachments: 350, sync: 0 });

      const rows = registry.registryStmts.listAttachmentsForOwner.all(id) as { file_id: string; size_bytes: number }[];
      expect(rows.map((r) => [r.file_id, r.size_bytes]).sort()).toEqual([['a.enc', 100], ['b.enc', 250]]);
    });

    it('records the uploader as the owner and no workspace, before sharing exists', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 10);
      quota.reconcileUserUsage(id);
      expect(registry.registryStmts.listAttachmentsForOwner.all(id)).toEqual([
        { file_id: 'a.enc', workspace_id: '', owner_user_id: id, uploader_user_id: id, size_bytes: 10 },
      ]);
    });

    it('follows a file that grew, and one that is gone', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 100);
      writeUpload(id, 'b.enc', 100);
      quota.reconcileUserUsage(id);

      writeUpload(id, 'a.enc', 300);
      fs.rmSync(path.join(tmpDir, 'uploads', id, 'b.enc'));
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(300);
      expect(usageOf(id)?.attachments).toBe(300);
      expect((registry.registryStmts.listAttachmentsForOwner.all(id) as unknown[]).length).toBe(1);
    });

    it('repairs a counter that is wrong', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 40);
      registry.registryStmts.setUsedBytes.run({ user_id: id, kind: 'attachments', used_bytes: 999_999, updated_at: 1 });
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(40);
      expect(usageOf(id)?.attachments).toBe(40);
    });

    it('is zero for an account that has never uploaded', () => {
      const id = addUser();
      expect(quota.reconcileUserUsage(id)).toEqual({ attachments: 0, sync: 0 });
    });

    it('keeps two accounts\' files apart when they have the same name', () => {
      const a = addUser();
      const b = addUser();
      writeUpload(a, 'same.enc', 100);
      writeUpload(b, 'same.enc', 7);
      quota.reconcileUserUsage(a);
      quota.reconcileUserUsage(b);
      expect(usageOf(a)?.attachments).toBe(100);
      expect(usageOf(b)?.attachments).toBe(7);

      // And one account's file going away leaves the other's row alone.
      fs.rmSync(path.join(tmpDir, 'uploads', a, 'same.enc'));
      quota.reconcileUserUsage(a);
      expect(usageOf(a)?.attachments).toBe(0);
      expect(usageOf(b)?.attachments).toBe(7);
      expect(quota.reconcileUserUsage(b)?.attachments).toBe(7);
    });

    it('does not count another account\'s files', () => {
      const a = addUser();
      const b = addUser();
      writeUpload(a, 'a.enc', 100);
      writeUpload(b, 'b.enc', 7);
      quota.reconcileUserUsage(a);
      quota.reconcileUserUsage(b);
      expect(usageOf(a)?.attachments).toBe(100);
      expect(usageOf(b)?.attachments).toBe(7);
    });

    it('counts the bytes of Yjs updates in the account\'s own database', () => {
      const id = addUser();
      const handle = userDb.getUserDb(id);
      handle.stmts.insertDocument.run({
        id: 'd1', parent_id: null, type: 'page', position: 'a0', properties: '{}', created_at: 1, updated_at: 1,
        last_struct_ts: 1, status: 0, status_timestamp: 1, last_properties_ts: 1,
      });
      handle.db.prepare('INSERT INTO yjs_updates (document_id, data, created_at) VALUES (?, ?, ?)').run('d1', Buffer.alloc(1000), 1);
      handle.db.prepare('INSERT INTO yjs_updates (document_id, data, created_at) VALUES (?, ?, ?)').run('d1', Buffer.alloc(234), 2);

      expect(quota.reconcileUserUsage(id)?.sync).toBe(1234);
      expect(usageOf(id)?.sync).toBe(1234);
    });

    it('keeps the sync figure it had when the database cannot be read', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = addUser();
      registry.registryStmts.setUsedBytes.run({ user_id: id, kind: 'sync', used_bytes: 555, updated_at: 1 });
      fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'users', `${id}.db`), 'this is not a database');

      expect(quota.reconcileUserUsage(id)?.sync).toBe(555);
      expect(usageOf(id)?.sync).toBe(555);
    });

    it('does nothing for an account that does not exist', () => {
      expect(quota.reconcileUserUsage(randomUUID())).toBeNull();
    });

    it('is gone with the account', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 10);
      quota.reconcileUserUsage(id);
      registry.registryStmts.deleteUser.run(id);
      expect(usageOf(id)).toBeUndefined();
      expect(registry.registryStmts.listAttachmentsForOwner.all(id)).toEqual([]);
    });
  });

  describe('reconcileAllUsage', () => {
    it('reconciles real accounts and leaves demo accounts out', async () => {
      const real = addUser();
      writeUpload(real, 'a.enc', 12);
      const demoId = randomUUID();
      registry.registryStmts.createDemoUser.run({
        id: demoId, email: `${demoId}@demo.local`, properties: '{}', created_at: Date.now(), demo_expires_at: Date.now() + 1000,
      });
      writeUpload(demoId, 'd.enc', 99);

      expect(await quota.reconcileAllUsage()).toBe(1);
      expect(quota.listUsageByUser().get(real)?.attachments).toBe(12);
      expect(quota.listUsageByUser().has(demoId)).toBe(false);
    });
  });

  describe('newAccountDiskQuotaBytes', () => {
    it('is 10 GiB unless set', () => {
      expect(quota.DEFAULT_DISK_QUOTA_BYTES).toBe(10737418240);
      expect(quota.newAccountDiskQuotaBytes(undefined)).toBe(10737418240);
      expect(quota.newAccountDiskQuotaBytes('')).toBe(10737418240);
      expect(quota.newAccountDiskQuotaBytes('   ')).toBe(10737418240);
    });

    it('is the number of bytes it is set to, zero included, whole', () => {
      expect(quota.newAccountDiskQuotaBytes('5368709120')).toBe(5368709120);
      expect(quota.newAccountDiskQuotaBytes(' 1048576 ')).toBe(1048576);
      expect(quota.newAccountDiskQuotaBytes('0')).toBe(0);
      expect(quota.newAccountDiskQuotaBytes('1536.9')).toBe(1536);
    });

    it('is no limit when set to unlimited, in any case', () => {
      expect(quota.newAccountDiskQuotaBytes('unlimited')).toBeNull();
      expect(quota.newAccountDiskQuotaBytes('UNLIMITED')).toBeNull();
    });

    it('is the default, and says so, for anything else', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const bad of ['10GB', '-1', 'NaN', 'Infinity', 'none']) {
        expect(quota.newAccountDiskQuotaBytes(bad), bad).toBe(10737418240);
      }
      expect(warn).toHaveBeenCalledTimes(5);
    });
  });

  describe('recordUpload', () => {
    const rowsOf = (id: string) => registry.registryStmts.listAttachmentsForOwner.all(id) as {
      file_id: string; workspace_id: string; size_bytes: number;
    }[];

    it('corrects a file the reconcile job saw while it was still being written', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 30);            // the stream so far
      quota.reconcileUserUsage(id);
      expect(rowsOf(id)[0].size_bytes).toBe(30);

      writeUpload(id, 'a.enc', 200);           // and the whole file
      quota.recordUpload({ userId: id, workspaceId: 'ws1', fileId: 'a.enc', size: 200 });
      expect(rowsOf(id)).toMatchObject([{ file_id: 'a.enc', workspace_id: 'ws1', size_bytes: 200 }]);
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(200);
    });

    it('counts a file the reconcile job already counted once, not twice', () => {
      const id = addUser();
      writeUpload(id, 'a.enc', 50);
      quota.reconcileUserUsage(id);
      quota.recordUpload({ userId: id, workspaceId: '', fileId: 'a.enc', size: 50 });
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(50);
    });

    it('measures an account it has never measured, rather than counting the one upload', () => {
      const id = addUser();
      writeUpload(id, 'old.enc', 800);
      writeUpload(id, 'new.enc', 100);
      expect(quota.listUsageByUser().has(id)).toBe(false);
      quota.recordUpload({ userId: id, workspaceId: '', fileId: 'new.enc', size: 100 });
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(900);
    });

    it('does nothing for an account that is not registered', () => {
      quota.recordUpload({ userId: randomUUID(), workspaceId: '', fileId: 'a.enc', size: 5 });
      expect(quota.listUsageByUser().size).toBe(0);
    });
  });
});
