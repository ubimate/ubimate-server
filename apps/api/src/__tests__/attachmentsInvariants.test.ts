// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * The attachment ledger, the usage counters and the stored objects under a long random run of operations
 * (docs/ATTACHMENT-ENCRYPTION.md 5.2, 6; docs/DISK-QUOTAS.md 3, 4). The named scenarios in attachments.test.ts
 * check what each route does; this checks what must stay true however they interleave:
 *
 *  - an account's usage counter is exactly what its confirmed attachments add up to (and reconcile agrees);
 *  - no limited account is over its limit;
 *  - a confirmed attachment has its object, at its recorded size, and a pending one has no size yet;
 *  - an account's room is its limit less what it uses and what its pending uploads have held;
 *  - the confirmed attachments are exactly those a confirm made and no delete took: nothing else adds or removes one,
 *    and a presign is never answered with a URL for one that is confirmed;
 *  - after the cleanup job has run to the end of time, nothing is left that no confirmed row names;
 *  - no operation is ever answered with a server error.
 *
 * Seeded, so a failure names the seed and the step and replays. Runs against the disk, and against a bucket
 * (a fake with the real store's interface), where the API may not delete: only the cleanup job removes objects.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WS1 = 'ws-1';   // owned by OWNER; members OWNER and GUEST
const WS2 = 'ws-2';   // no recorded owner; members GUEST and OUTSIDER
const USERS = ['owner', 'guest', 'outsider'] as const;
const LIMITS: Record<string, number | null> = { owner: 6000, guest: null, outsider: 2500 };
const IDS = Array.from({ length: 10 }, (_, i) => `att-${i}`);
const WRAPPED = 'w'.repeat(96);
const OVERHEAD = 41;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Bucket {
  objects = new Map<string, number>();
  async presignPut(key: string, size: number) { return { url: `https://b.test/${key}?s=${size}`, headers: {} }; }
  async presignGet(key: string) { return `https://b.test/${key}?g`; }
  // Takes time, as a call over the network does: requests then interleave at this await.
  async head(key: string) { await new Promise((r) => setTimeout(r, 4)); return this.objects.get(key) ?? null; }
  async delete(key: string) { this.objects.delete(key); }
}

describe.each([['disk', false], ['bucket', true]] as const)('accounting invariants (%s)', (_label, useBucket) => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let port = 0;
  let registry: typeof import('../db/registry');
  let quota: typeof import('../lib/quota');
  let lib: typeof import('../lib/attachments');
  let bucket: Bucket;
  let current = 'owner';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-attachments-inv-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.UPLOAD_MAX_SIZE_MB = '1';
    vi.resetModules();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = current;
        (req as Request & { isDemo: boolean }).isDemo = false;
        next();
      },
    }));
    registry = await import('../db/registry');
    quota = await import('../lib/quota');
    lib = await import('../lib/attachments');
    const objectStore = await import('../lib/objectStore');
    bucket = new Bucket();
    objectStore.setObjectStoreForTests(useBucket ? bucket : null);

    for (const u of USERS) {
      registry.registryStmts.createUser.run({
        id: u, email: `${u}@example.com`, properties: JSON.stringify(LIMITS[u] === null ? {} : { service: { diskQuotaBytes: LIMITS[u] } }),
        created_at: Date.now(), status: 'active', public_key: null, wrapped_content_key: null, user_type: 'free',
      });
    }
    const member = (ws: string, u: string) => registry.registryStmts.insertWorkspaceKey.run({ workspace_id: ws, user_id: u, wrapped_key: 's', granted_at: 1 });
    member(WS1, 'owner'); member(WS1, 'guest'); member(WS2, 'guest'); member(WS2, 'outsider');
    registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS1, owner_user_id: 'owner' });

    const { attachmentsRouter } = await import('../routes/attachments');
    const app = express();
    app.use(express.json());
    app.use('/api/attachments', attachmentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
      server = null;
    }
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'NODE_ENV', 'UPLOAD_MAX_SIZE_MB']) delete process.env[k];
    vi.resetModules();
  });

  /** Every row there is: the ids the run uses are a fixed pool. */
  const rows = () => IDS.map((id) => registry.registryStmts.getAttachment.get(id) as import('../db/registry').AttachmentRow | undefined).filter((r): r is import('../db/registry').AttachmentRow => !!r);
  const status: number[] = [];
  const call = async (user: string, method: string, url: string, body?: unknown): Promise<number> => {
    current = user;
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    await res.arrayBuffer();
    status.push(res.status);
    return res.status;
  };
  /** A PUT of `n` bytes without a length up front, so a body shorter or longer than declared reaches the server. */
  const putBytes = (user: string, id: string, n: number): Promise<number> => new Promise((resolve, reject) => {
    current = user;
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/attachments/${id}/content`, headers: { 'Transfer-Encoding': 'chunked' } });
    req.on('response', (res) => { res.resume(); res.on('end', () => { status.push(res.statusCode ?? 0); resolve(res.statusCode ?? 0); }); });
    req.on('error', reject);
    req.end(Buffer.alloc(n, 1));
  });

  const confirmedIds = () => rows().filter((r) => r.status === 'confirmed').map((r) => r.attachment_id).sort();

  function check(ctx: string): void {
    const all = rows();
    for (const u of USERS) {
      if (LIMITS[u] === null) continue;
      const held = all.filter((r) => r.owner_user_id === u && r.status === 'pending').reduce((n, r) => n + r.expected_size, 0);
      const used = all.filter((r) => r.owner_user_id === u && r.status === 'confirmed').reduce((n, r) => n + (r.size_bytes ?? 0), 0);
      expect(quota.remainingBytes(u, LIMITS[u]), `${ctx}: room of ${u}`).toBe(Math.max(0, LIMITS[u]! - used - held));
    }
    for (const u of USERS) {
      const charged = all.filter((r) => r.owner_user_id === u && r.status === 'confirmed').reduce((n, r) => n + (r.size_bytes ?? 0), 0);
      expect(quota.attachmentsUsed(u), `${ctx}: usage of ${u}`).toBe(charged);
      if (LIMITS[u] !== null) expect(charged, `${ctx}: ${u} over its limit`).toBeLessThanOrEqual(LIMITS[u]!);
    }
    for (const r of all) {
      if (r.status === 'confirmed') {
        expect(r.size_bytes, `${ctx}: ${r.attachment_id} confirmed without a size`).toBe(r.expected_size);
        const stored = useBucket ? bucket.objects.get(r.storage_key) : (() => { try { return fs.statSync(path.join(tmpDir, 'uploads', r.storage_key)).size; } catch { return undefined; } })();
        expect(stored, `${ctx}: ${r.attachment_id} confirmed but its object is not there at its size`).toBe(r.size_bytes);
      } else if (r.status === 'pending') {
        // Also a row revived from `deleted`: nothing is stored under it yet, whatever it was.
        expect(r.size_bytes, `${ctx}: ${r.attachment_id} pending with a size`).toBeNull();
      }
    }
    expect(status.filter((s) => s >= 500), `${ctx}: server errors`).toEqual([]);
  }

  async function sweep(ctx: string): Promise<void> {
    await lib.cleanupAttachments(Date.now() + 3 * 3600_000);
    const all = rows();
    expect(all.filter((r) => r.status !== 'confirmed'), `${ctx}: rows left after the cleanup`).toEqual([]);
    const named = new Set(all.map((r) => r.storage_key));
    if (useBucket) {
      expect([...bucket.objects.keys()].filter((k) => !named.has(k)), `${ctx}: objects no row names`).toEqual([]);
    } else {
      const found: string[] = [];
      const walk = (dir: string) => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else found.push(path.relative(path.join(tmpDir, 'uploads'), p)); } };
      walk(path.join(tmpDir, 'uploads'));
      expect(found.filter((f) => !named.has(f)), `${ctx}: files no row names`).toEqual([]);
    }
    check(ctx);
  }

  it.each([1, 2, 3, 4, 5, 6])('holds across 160 random operations (seed %i)', async (seed) => {
    const r = rng(seed * 7919);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const sizeOf = () => 50 + Math.floor(r() * 2400);

    for (let step = 0; step < 160; step++) {
      const user = pick(USERS);
      const id = pick(IDS);
      const row = rows().find((x) => x.attachment_id === id);
      const op = r();
      const ctx = `seed ${seed} step ${step} (${user} ${op.toFixed(2)} ${id})`;
      const confirmedBefore = confirmedIds();
      let expected = confirmedBefore;     // what the confirmed set must be after this step

      if (op < 0.30) {
        // presign: a new id or a retry (maybe with another size), into a Space the user is in or not
        // Half the time again for an attachment that exists, by whoever made it and where: a retry, or a second try for one
        // that is stored already.
        const again = row && r() < 0.5;
        const asUser = again ? row.uploader_user_id : user;
        const ws = again ? row.workspace_id : pick(user === 'owner' ? [WS1, WS1, WS2] : user === 'guest' ? [WS1, WS2] : [WS2, WS2, WS1]);
        const code = await call(asUser, 'POST', '/api/attachments/presign', { workspaceId: ws, attachmentId: id, size: sizeOf() + OVERHEAD, kind: 'file', keyVersion: 1, wrappedKey: WRAPPED });
        // A URL to write to is given only for an attachment that is not stored yet.
        if (code === 200) expect(rows().find((x) => x.attachment_id === id)?.status, `${ctx}: a presign answered for a stored attachment`).toBe('pending');
      } else if (op < 0.55) {
        // the bytes, right or wrong, for whatever the row says it expects
        if (row?.status === 'pending') {
          const wrong = r() < 0.3 ? pick([-3, -1, 1, 40]) : 0;
          if (useBucket) bucket.objects.set(row.storage_key, row.expected_size + wrong);
          else await putBytes(row.uploader_user_id, id, row.expected_size + wrong);
        }
      } else if (op < 0.62 && row?.status === 'pending') {
        // the same confirm sent several times at once (a client that retried while its answer was on the way)
        const who = row.uploader_user_id;
        const codes = await Promise.all([1, 2, 3].map(() => call(who, 'POST', `/api/attachments/${id}/confirm`)));
        if (codes.includes(200)) expected = [...new Set([...confirmedBefore, id])].sort();
      } else if (op < 0.75) {
        const code = await call(r() < 0.9 && row ? row.uploader_user_id : user, 'POST', `/api/attachments/${id}/confirm`);
        if (code === 200) expected = [...new Set([...confirmedBefore, id])].sort();
      } else if (op < 0.88) {
        const code = await call(user, 'DELETE', `/api/attachments/${id}`);
        if (code === 204) expected = confirmedBefore.filter((x) => x !== id);
      } else if (op < 0.93) {
        await lib.cleanupAttachments();
      } else if (op < 0.96) {
        await lib.cleanupAttachments(Date.now() + 3 * 3600_000);   // time passes: stale pending uploads go
      } else {
        // resolve and list change nothing
        const before = JSON.stringify(rows());
        await call(user, 'POST', '/api/attachments/resolve', { ids: IDS });
        await call(user, 'GET', '/api/attachments');
        expect(JSON.stringify(rows()), `${ctx}: a read changed the ledger`).toBe(before);
      }
      expect(confirmedIds(), `${ctx}: the confirmed attachments changed otherwise than by a confirm or a delete`).toEqual(expected);
      check(ctx);

      if (step % 40 === 39) {
        // Reconcile (the job that repairs the counters) must find nothing to repair.
        const used = USERS.map((u) => quota.attachmentsUsed(u));
        for (const u of USERS) quota.reconcileUserUsage(u);
        expect(USERS.map((u) => quota.attachmentsUsed(u)), `${ctx}: reconcile changed a counter`).toEqual(used);
      }
    }
    await sweep(`seed ${seed} end`);
  }, 120_000);
});
