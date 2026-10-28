/**
 * Storage quotas — the limit an account has and the bytes it uses (docs/DISK-QUOTAS.md).
 *
 * The limit lives in the user's `properties`, under `service.diskQuotaBytes`; only the server writes
 * it (the admin route). Usage is counted in the registry's `usage` table and kept honest by the
 * reconcile job here, never by scanning on a request.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registryStmts, parseUserProperties } from '../db/registry';
import type { UserRow } from '../db/registry';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');

export type UsageKind = 'attachments' | 'sync';

export interface UsageTotals {
  attachments: number;
  sync: number;
}

// ---------------------------------------------------------------------------
// The limit
// ---------------------------------------------------------------------------

/** Whether `value` can be stored as a limit: a finite number of at least zero. */
export function isValidQuotaBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const warned = new Set<string>();

/**
 * The attachment limit in bytes for `row`, or null for unlimited. A missing `service` or
 * `diskQuotaBytes` is unlimited; a value that is not a finite number of at least zero is treated as
 * missing and logged once, so a bad edit cannot lock an account out.
 */
export function getQuotaBytes(row: Pick<UserRow, 'id' | 'properties'>): number | null {
  const service = parseUserProperties(row as UserRow).service;
  if (service === undefined || service === null) return null;
  const value = (service as Record<string, unknown>).diskQuotaBytes;
  if (value === undefined) return null;
  if (isValidQuotaBytes(value)) return value;
  if (!warned.has(row.id)) {
    warned.add(row.id);
    console.warn(`[quota] user ${row.id}: service.diskQuotaBytes is not a number of at least zero; treated as unlimited`);
  }
  return null;
}

/** What a new account may store as attachments unless the server says otherwise: 10 GiB (docs/DISK-QUOTAS.md §4.3). */
export const DEFAULT_DISK_QUOTA_BYTES = 10 * 1024 ** 3;

/**
 * The attachment limit a newly registered account starts with: `NEW_ACCOUNT_DISK_QUOTA_BYTES` when set
 * to a number of bytes, none (unlimited) when it is `unlimited` — for a self-hosted server that wants no
 * limit — and 10 GiB otherwise, including when it is set to something that is neither, which is logged.
 * Read when an account is made, so a change needs no restart of anything but the setting.
 */
export function newAccountDiskQuotaBytes(setting: string | undefined = process.env.NEW_ACCOUNT_DISK_QUOTA_BYTES): number | null {
  const raw = setting?.trim();
  if (!raw) return DEFAULT_DISK_QUOTA_BYTES;
  if (raw.toLowerCase() === 'unlimited') return null;
  const bytes = Number(raw);
  if (isValidQuotaBytes(bytes)) return Math.floor(bytes);
  console.warn(`[quota] NEW_ACCOUNT_DISK_QUOTA_BYTES is "${raw}", not a number of bytes or "unlimited"; using ${DEFAULT_DISK_QUOTA_BYTES}`);
  return DEFAULT_DISK_QUOTA_BYTES;
}

/**
 * `properties` with `service.diskQuotaBytes` set, or removed when `bytes` is null. Everything else in
 * `properties`, and the rest of `service`, is kept; an emptied `service` is dropped.
 */
export function withDiskQuota(properties: Record<string, unknown>, bytes: number | null): Record<string, unknown> {
  const current = properties.service;
  const service: Record<string, unknown> =
    current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (bytes === null) delete service.diskQuotaBytes;
  else service.diskQuotaBytes = bytes;
  const next = { ...properties };
  if (Object.keys(service).length === 0) delete next.service;
  else next.service = service;
  return next;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// Bytes promised to uploads that are streaming now, per account. Held here, not in the database: it
// is true only while this process is running, and a crash then loses nothing that needs repair.
const reserved = new Map<string, number>();

function reservedFor(userId: string): number {
  return reserved.get(userId) ?? 0;
}

/**
 * What the account has stored as attachments. An account that has never been measured is measured
 * now, so a limit is never checked against an empty count.
 */
export function attachmentsUsed(userId: string): number {
  const row = registryStmts.getUsageRow.get(userId, 'attachments') as { used_bytes: number } | undefined;
  if (row) return row.used_bytes;
  return reconcileUserUsage(userId)?.attachments ?? 0;
}

/** How many more bytes the account may store, counting uploads in flight; null when unlimited. */
export function remainingBytes(userId: string, limit: number | null): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - attachmentsUsed(userId) - reservedFor(userId));
}

/**
 * Promise `bytes` to an upload. Refused, with nothing promised, when they do not fit under `limit`
 * beside what is stored and what other uploads have promised. Accepted without counting when there is
 * no limit, so the caller can release unconditionally.
 */
export function tryReserve(userId: string, limit: number | null, bytes: number): boolean {
  if (limit === null) return true;
  const remaining = remainingBytes(userId, limit) ?? 0;
  if (bytes > remaining) return false;
  reserved.set(userId, reservedFor(userId) + bytes);
  return true;
}

/** Give back what `tryReserve` promised. */
export function releaseReservation(userId: string, limit: number | null, bytes: number): void {
  if (limit === null) return;
  const left = reservedFor(userId) - bytes;
  if (left > 0) reserved.set(userId, left);
  else reserved.delete(userId);
}

/**
 * Record a stored upload: a ledger row and the account's usage moved by its size. A file the
 * reconcile job has already found is not counted twice. The uploader is the owner until sharing
 * exists. Does nothing for an id that is not a registered account.
 */
export function recordUpload(args: { userId: string; workspaceId: string; fileId: string; size: number }): void {
  if (!registryStmts.getUserById.get(args.userId)) return;
  const now = Date.now();
  // An account never measured has no figure to move by this upload's size: moving it would leave a
  // count of this one file, short of everything else the account holds. It is measured instead.
  const measured = registryStmts.getUsageRow.get(args.userId, 'attachments') !== undefined;
  const inserted = registryStmts.insertAttachment.run({
    file_id: args.fileId, workspace_id: args.workspaceId, owner_user_id: args.userId,
    uploader_user_id: args.userId, size_bytes: args.size, created_at: now,
  });
  if (inserted.changes === 1) {
    if (measured) registryStmts.addUsedBytes.run({ user_id: args.userId, kind: 'attachments', delta: args.size, updated_at: now });
  } else {
    // The reconcile job found the file first — perhaps while it was still being written, and so
    // ledgered it short. What was stored is the truth: correct the row, and the count by the difference.
    const row = registryStmts.getAttachment.get(args.userId, args.fileId) as
      { size_bytes: number; workspace_id: string } | undefined;
    if (row && row.size_bytes !== args.size) {
      registryStmts.updateAttachmentSize.run({ uploader_user_id: args.userId, file_id: args.fileId, size_bytes: args.size });
      if (measured) {
        registryStmts.addUsedBytes.run({ user_id: args.userId, kind: 'attachments', delta: args.size - row.size_bytes, updated_at: now });
      }
    }
    if (row && row.workspace_id !== args.workspaceId) {
      registryStmts.setAttachmentWorkspace.run({ uploader_user_id: args.userId, file_id: args.fileId, workspace_id: args.workspaceId });
    }
  }
  if (!measured) reconcileUserUsage(args.userId);
}

/**
 * Forget a deleted upload and give its bytes back to its owner. Returns what the ledger held for it,
 * or null when there was no row.
 */
export function forgetUpload(userId: string, fileId: string): { size_bytes: number; owner_user_id: string } | null {
  const row = registryStmts.getAttachment.get(userId, fileId) as { size_bytes: number; owner_user_id: string } | undefined;
  if (!row) return null;
  registryStmts.deleteAttachment.run(userId, fileId);
  registryStmts.addUsedBytes.run({ user_id: row.owner_user_id, kind: 'attachments', delta: -row.size_bytes, updated_at: Date.now() });
  return row;
}

/** Every account's usage as last reconciled; an account never reconciled has no entry. */
export function listUsageByUser(): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  const rows = registryStmts.listUsage.all() as { user_id: string; kind: UsageKind; used_bytes: number }[];
  for (const r of rows) {
    const totals = out.get(r.user_id) ?? { attachments: 0, sync: 0 };
    totals[r.kind] = r.used_bytes;
    out.set(r.user_id, totals);
  }
  return out;
}

/**
 * Bring the ledger in line with the files in `uploads/<userId>/` — a row for each file, its size as
 * stored, no row for a file that is gone — and return the bytes the account owns. A file is known by
 * its uploader's directory and its name in it, so two accounts' files never collide.
 */
function reconcileAttachments(userId: string): number {
  const dir = path.join(DATA_DIR, 'uploads', userId);
  const onDisk = new Map<string, number>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No uploads directory: the user has never uploaded.
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      onDisk.set(e.name, fs.statSync(path.join(dir, e.name)).size);
    } catch {
      // Gone between the listing and the stat.
    }
  }

  const known = new Map(
    (registryStmts.listAttachmentsByUploader.all(userId) as { file_id: string; size_bytes: number }[])
      .map((r) => [r.file_id, r.size_bytes]),
  );
  const now = Date.now();
  for (const [fileId, size] of onDisk) {
    if (!known.has(fileId)) {
      registryStmts.insertAttachment.run({
        file_id: fileId, workspace_id: '', owner_user_id: userId, uploader_user_id: userId, size_bytes: size, created_at: now,
      });
    } else if (known.get(fileId) !== size) {
      registryStmts.updateAttachmentSize.run({ uploader_user_id: userId, file_id: fileId, size_bytes: size });
    }
  }
  for (const fileId of known.keys()) {
    if (!onDisk.has(fileId)) registryStmts.deleteAttachment.run(userId, fileId);
  }
  return (registryStmts.sumAttachmentsForOwner.get(userId) as { total: number }).total;
}

/** The bytes of Yjs updates in the account's own database, or null when it cannot be read. */
function syncBytes(userId: string): number | null {
  const dbPath = path.join(DATA_DIR, 'users', `${userId}.db`);
  if (!fs.existsSync(dbPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    const row = db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM yjs_updates').get() as { total: number };
    return row.total;
  } catch (err) {
    console.warn(`[quota] could not measure sync usage for ${userId}:`, err);
    return null;
  } finally {
    db?.close();
  }
}

/** Recompute one account's usage from the disk and its database and store it. */
export function reconcileUserUsage(userId: string): UsageTotals | null {
  if (!registryStmts.getUserById.get(userId)) return null;
  const now = Date.now();
  const attachments = reconcileAttachments(userId);
  registryStmts.setUsedBytes.run({ user_id: userId, kind: 'attachments', used_bytes: attachments, updated_at: now });
  // An unreadable database keeps the figure it had, rather than reading as empty.
  const sync = syncBytes(userId);
  if (sync !== null) registryStmts.setUsedBytes.run({ user_id: userId, kind: 'sync', used_bytes: sync, updated_at: now });
  const stored = listUsageByUser().get(userId);
  return { attachments, sync: sync ?? stored?.sync ?? 0 };
}

/** Reconcile every real account, yielding between them so a large server keeps answering requests. */
export async function reconcileAllUsage(): Promise<number> {
  const users = (registryStmts.listUsers.all() as { id: string; is_demo: number }[]).filter((u) => u.is_demo !== 1);
  for (const u of users) {
    try {
      reconcileUserUsage(u.id);
    } catch (err) {
      console.warn(`[quota] reconcile failed for ${u.id}:`, err);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return users.length;
}

const RECONCILE_DELAY_MS = 15_000;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Reconcile shortly after startup, then daily. The timers do not keep the process alive. */
export function scheduleUsageReconcile(): void {
  const run = (): void => {
    reconcileAllUsage()
      .then((n) => console.log(`[quota] reconciled usage for ${n} account(s)`))
      .catch((err) => console.warn('[quota] reconcile failed:', err));
  };
  setTimeout(run, RECONCILE_DELAY_MS).unref();
  setInterval(run, RECONCILE_INTERVAL_MS).unref();
}
