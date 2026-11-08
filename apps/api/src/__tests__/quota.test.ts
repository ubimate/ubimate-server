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

  /** A ledger row for `userId`, `pending` or `confirmed` at `bytes`. Moves no usage: reconcile or confirmAttachment does. */
  function addAttachment(userId: string, attachmentId: string, bytes: number, status: 'pending' | 'confirmed' = 'confirmed'): void {
    registry.registryStmts.insertPendingAttachment.run({
      attachment_id: attachmentId, workspace_id: 'ws1', uploader_user_id: userId, owner_user_id: userId, kind: 'file',
      storage: 'local', storage_key: `${userId}/${attachmentId}`, key_version: 1, wrapped_key: 'k', expected_size: bytes,
      created_at: Date.now(),
    });
    if (status === 'confirmed') registry.registryStmts.confirmAttachment.run({ attachment_id: attachmentId, size_bytes: bytes });
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

    it('adds up the confirmed attachments the account owns', () => {
      const id = addUser();
      addAttachment(id, 'a', 100);
      addAttachment(id, 'b', 250);

      expect(quota.reconcileUserUsage(id)).toEqual({ attachments: 350, sync: 0 });
      expect(usageOf(id)).toEqual({ attachments: 350, sync: 0 });
    });

    it('does not count a pending attachment, whose bytes are only promised', () => {
      const id = addUser();
      addAttachment(id, 'a', 100);
      addAttachment(id, 'b', 5000, 'pending');
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(100);
    });

    it('does not count a file on the disk that has no row: it was never confirmed', () => {
      const id = addUser();
      fs.mkdirSync(path.join(tmpDir, 'uploads', id), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'uploads', id, 'stray'), Buffer.alloc(900));
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(0);
    });

    it('follows a row that was forgotten', () => {
      const id = addUser();
      addAttachment(id, 'a', 100);
      addAttachment(id, 'b', 100);
      quota.reconcileUserUsage(id);
      quota.forgetAttachment('b');
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(100);
      expect(usageOf(id)?.attachments).toBe(100);
    });

    it('repairs a counter that is wrong', () => {
      const id = addUser();
      addAttachment(id, 'a', 40);
      registry.registryStmts.setUsedBytes.run({ user_id: id, kind: 'attachments', used_bytes: 999_999, updated_at: 1 });
      expect(quota.reconcileUserUsage(id)?.attachments).toBe(40);
      expect(usageOf(id)?.attachments).toBe(40);
    });

    it('is zero for an account that has never uploaded', () => {
      const id = addUser();
      expect(quota.reconcileUserUsage(id)).toEqual({ attachments: 0, sync: 0 });
    });

    it('does not count another account\'s attachments', () => {
      const a = addUser();
      const b = addUser();
      addAttachment(a, 'a', 100);
      addAttachment(b, 'b', 7);
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
      addAttachment(id, 'a', 10);
      quota.reconcileUserUsage(id);
      registry.registryStmts.deleteUser.run(id);
      expect(usageOf(id)).toBeUndefined();
      expect(registry.registryStmts.getAttachment.get('a')).toBeUndefined();
    });
  });

  describe('reconcileAllUsage', () => {
    it('reconciles every account', async () => {
      const first = addUser();
      addAttachment(first, 'a', 12);
      const second = addUser();
      addAttachment(second, 'b', 99);

      expect(await quota.reconcileAllUsage()).toBe(2);
      expect(quota.listUsageByUser().get(first)?.attachments).toBe(12);
      expect(quota.listUsageByUser().get(second)?.attachments).toBe(99);
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

  describe('confirmAttachment', () => {
    it('charges the owner and marks the row confirmed', () => {
      const id = addUser();
      addAttachment(id, 'a', 100, 'pending');
      quota.reconcileUserUsage(id);
      const row = registry.registryStmts.getAttachment.get('a') as import('../db/registry').AttachmentRow;
      expect(quota.confirmAttachment(row, 100)).toBe(true);
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(100);
      expect(registry.registryStmts.getAttachment.get('a')).toMatchObject({ status: 'confirmed', size_bytes: 100 });
    });

    it('charges once however often it is called', () => {
      const id = addUser();
      addAttachment(id, 'a', 100, 'pending');
      const row = registry.registryStmts.getAttachment.get('a') as import('../db/registry').AttachmentRow;
      expect(quota.confirmAttachment(row, 100)).toBe(true);
      expect(quota.confirmAttachment(row, 100)).toBe(false);
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(100);
    });

    it('measures an account it has never measured, rather than counting the one attachment', () => {
      const id = addUser();
      addAttachment(id, 'old', 800);
      addAttachment(id, 'new', 100, 'pending');
      expect(quota.listUsageByUser().has(id)).toBe(false);
      const row = registry.registryStmts.getAttachment.get('new') as import('../db/registry').AttachmentRow;
      quota.confirmAttachment(row, 100);
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(900);
    });
  });

  describe('forgetAttachment and retireAttachment', () => {
    it('forget gives a confirmed attachment\'s bytes back and drops the row; a pending one gives nothing', () => {
      const id = addUser();
      addAttachment(id, 'a', 100);
      addAttachment(id, 'p', 50, 'pending');
      quota.reconcileUserUsage(id);
      quota.forgetAttachment('p');
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(100);
      quota.forgetAttachment('a');
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(0);
      expect(registry.registryStmts.getAttachment.get('a')).toBeUndefined();
    });

    it('retire gives the bytes back once and keeps the row as deleted', () => {
      const id = addUser();
      addAttachment(id, 'a', 100);
      quota.reconcileUserUsage(id);
      quota.retireAttachment('a');
      quota.retireAttachment('a');
      expect(quota.listUsageByUser().get(id)?.attachments).toBe(0);
      expect(registry.registryStmts.getAttachment.get('a')).toMatchObject({ status: 'deleted' });
    });
  });

  describe('holds', () => {
    it('count against the room until released, and a second hold for the same id replaces the first', () => {
      const id = addUser({ service: { diskQuotaBytes: 100 } });
      const later = Date.now() + 60_000;
      expect(quota.tryReserve(id, 100, 70, 'a', later)).toBe(true);
      expect(quota.tryReserve(id, 100, 70, 'b', later)).toBe(false);
      expect(quota.tryReserve(id, 100, 90, 'a', later)).toBe(true);   // a retry of a: replaced, not added
      expect(quota.remainingBytes(id, 100)).toBe(10);
      quota.releaseReservation('a');
      expect(quota.remainingBytes(id, 100)).toBe(100);
    });

    it('keep the earlier hold when a replacement does not fit', () => {
      const id = addUser();
      const later = Date.now() + 60_000;
      quota.tryReserve(id, 100, 60, 'a', later);
      expect(quota.tryReserve(id, 100, 200, 'a', later)).toBe(false);
      expect(quota.remainingBytes(id, 100)).toBe(40);
    });

    it('end by themselves when they expire', () => {
      const id = addUser();
      quota.tryReserve(id, 100, 100, 'a', Date.now() - 1);
      expect(quota.remainingBytes(id, 100)).toBe(100);
    });
  });
});
