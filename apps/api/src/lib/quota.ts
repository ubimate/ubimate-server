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
import type { AttachmentRow, UserRow } from '../db/registry';

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

// Bytes promised to attachments between presign and confirm, per hold (an attachment id). Held here,
// not in the database: it is true only while this process is running, and a crash then loses nothing
// that needs repair. A hold ends at confirm, or on its own at `expiresAt` (the upload URL's expiry).
interface Hold { userId: string; bytes: number; expiresAt: number }
const holds = new Map<string, Hold>();

function reservedFor(userId: string): number {
  const now = Date.now();
  let total = 0;
  for (const [id, h] of holds) {
    if (h.expiresAt <= now) holds.delete(id);
    else if (h.userId === userId) total += h.bytes;
  }
  return total;
}

/**
 * The account an upload into the Space `workspaceId` is charged to, and whose limit and usage it is checked
 * against (docs/DISK-QUOTAS.md §4.5): the Space's owner, whoever uploads, so a guest's files count against the
 * host. The uploader when the Space has no recorded owner (one made before owners were recorded, or not yet set
 * up on the server) or when its owner's account no longer exists.
 */
export function chargedAccount(workspaceId: string, uploaderUserId: string): string {
  const owner = (registryStmts.getSpaceOwner.get(workspaceId) as { owner_user_id: string } | undefined)?.owner_user_id;
  return owner && registryStmts.getUserById.get(owner) ? owner : uploaderUserId;
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
 * Promise `bytes` to the attachment `holdId`, until `expiresAt`. A hold already placed under the same id
 * is replaced, so a retried presign is not charged twice. Refused, with nothing promised and any earlier
 * hold kept, when they do not fit under `limit` beside what is stored and what other holds promise.
 * Accepted without counting when there is no limit, so the caller can release unconditionally.
 */
export function tryReserve(userId: string, limit: number | null, bytes: number, holdId: string, expiresAt: number): boolean {
  if (limit === null) return true;
  const earlier = holds.get(holdId);
  holds.delete(holdId);
  const remaining = remainingBytes(userId, limit) ?? 0;
  if (bytes > remaining) {
    if (earlier) holds.set(holdId, earlier);
    return false;
  }
  holds.set(holdId, { userId, bytes, expiresAt });
  return true;
}

/** Give back what `tryReserve` promised for `holdId`. */
export function releaseReservation(holdId: string): void {
  holds.delete(holdId);
}

/**
 * Charge a confirmed attachment to its owner: its row becomes `confirmed` at `size`, and the owner's
 * usage moves by it. Does nothing for an owner that is not a registered account, and returns false when
 * the row is no longer pending.
 */
export function confirmAttachment(row: Pick<AttachmentRow, 'attachment_id' | 'owner_user_id'>, size: number): boolean {
  if (!registryStmts.getUserById.get(row.owner_user_id)) return false;
  // An account never measured has no figure to move by this upload's size. It is measured first,
  // while this row is still pending and so not part of the sum, and then moved.
  attachmentsUsed(row.owner_user_id);
  const confirm = registryStmts.confirmAttachment.run({ attachment_id: row.attachment_id, size_bytes: size });
  if (confirm.changes !== 1) return false;
  registryStmts.addUsedBytes.run({ user_id: row.owner_user_id, kind: 'attachments', delta: size, updated_at: Date.now() });
  return true;
}

/**
 * Take an attachment out of the ledger and give a confirmed one's bytes back to its owner. Returns the
 * row as it was, or null when there was none.
 */
export function forgetAttachment(attachmentId: string): AttachmentRow | null {
  const row = registryStmts.getAttachment.get(attachmentId) as AttachmentRow | undefined;
  if (!row) return null;
  registryStmts.deleteAttachment.run(attachmentId);
  if (row.status === 'confirmed' && row.size_bytes !== null) {
    registryStmts.addUsedBytes.run({ user_id: row.owner_user_id, kind: 'attachments', delta: -row.size_bytes, updated_at: Date.now() });
  }
  return row;
}

/**
 * Mark an attachment `deleted` and give a confirmed one's bytes back, keeping the row so the cleanup job
 * can remove an object this process cannot (a bucket's).
 */
export function retireAttachment(attachmentId: string): void {
  const row = registryStmts.getAttachment.get(attachmentId) as AttachmentRow | undefined;
  if (!row || row.status === 'deleted') return;
  registryStmts.markAttachmentDeleted.run(attachmentId);
  if (row.status === 'confirmed' && row.size_bytes !== null) {
    registryStmts.addUsedBytes.run({ user_id: row.owner_user_id, kind: 'attachments', delta: -row.size_bytes, updated_at: Date.now() });
  }
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
 * What the account's confirmed attachments add up to. The ledger is the truth: a file on the disk
 * without a row was never confirmed, and the cleanup job (lib/attachments.ts) removes it.
 */
function reconcileAttachments(userId: string): number {
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
  const users = registryStmts.listUsers.all() as { id: string }[];
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
