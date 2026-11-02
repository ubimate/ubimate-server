/**
 * Attachment storage and access (docs/ATTACHMENT-ENCRYPTION.md 5.2, 6): where an object lives, who may
 * read it, what size a kind may have, and the job that removes what was never confirmed.
 *
 * Local mode keeps the ciphertext at DATA_DIR/uploads/<uploader>/<attachmentId>. The server never sees
 * a name or a MIME type, only the `kind` the client declares, so that is all a size cap can go by.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registryStmts } from '../db/registry';
import type { AttachmentKind, AttachmentRow } from '../db/registry';
import { forgetAttachment, releaseReservation } from './quota';
import { getObjectStore } from './objectStore';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
const UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');

/** Bytes a format 2 blob adds to its file: 0x02, a 24-byte nonce and a 16-byte tag (packages/crypto BLOB_OVERHEAD). */
export const BLOB_OVERHEAD_BYTES = 41;
/** A wrapped attachment key is 72 bytes, 96 characters of unpadded base64url (packages/crypto WRAPPED_KEY_BYTES). */
export const WRAPPED_KEY_CHARS = 96;

const mb = (name: string, fallback: number): number => (Number(process.env[name]) || fallback) * 1024 * 1024;

/**
 * The most a kind may be, in plaintext bytes. A client chooses its kind, so these are a guard against
 * mistakes and a bound on what one request may hold, not a check on what the bytes are: the quota is
 * what limits an account.
 */
export function maxPlaintextBytes(kind: AttachmentKind): number {
  switch (kind) {
    case 'image': return mb('MAX_IMAGE_UPLOAD_MB', 20);
    case 'video': return mb('MAX_VIDEO_UPLOAD_MB', 50);
    case 'audio': return mb('MAX_AUDIO_UPLOAD_MB', 100);
    case 'file': return mb('UPLOAD_MAX_SIZE_MB', 10);
  }
}

/** How long a presigned upload URL, and the bytes promised for it, last. */
export const PRESIGN_EXPIRY_PUT_MS = (Number(process.env.S3_PRESIGN_EXPIRY_PUT) || 900) * 1000;
/** How long an answer from `resolve` may be used before asking again. */
export const PRESIGN_EXPIRY_GET_MS = (Number(process.env.S3_PRESIGN_EXPIRY_GET) || 300) * 1000;
/** A `pending` row older than this is removed, with its object. */
export const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

/** Where an attachment is in the bucket (docs/ATTACHMENT-ENCRYPTION.md 5.2). */
export function bucketStorageKey(attachmentId: string): string {
  return `a/${attachmentId}`;
}

/** Where a local attachment is stored, relative to the uploads directory. */
export function localStorageKey(uploaderUserId: string, attachmentId: string): string {
  return `${uploaderUserId}/${attachmentId}`;
}

/** The absolute path of a local attachment, or null if its stored key would leave the uploads directory. */
export function localPath(row: Pick<AttachmentRow, 'storage_key'>): string | null {
  const target = path.resolve(UPLOADS_ROOT, row.storage_key);
  return target.startsWith(UPLOADS_ROOT + path.sep) ? target : null;
}

/** The partial file a local upload streams into before it takes the final name. */
export function partialPath(finalPath: string): string {
  return `${finalPath}.part`;
}

/**
 * Whether `userId` may read this attachment: a current member of its Space, being a user with a
 * `workspace_keys` row for it. A Space nobody has a key for is not set up on the server yet, and there
 * its uploader is the only one who can read it.
 */
export function canRead(userId: string, row: Pick<AttachmentRow, 'workspace_id' | 'uploader_user_id'>): boolean {
  const { count } = registryStmts.countWorkspaceKeys.get(row.workspace_id) as { count: number };
  if (count === 0) return row.uploader_user_id === userId;
  return registryStmts.getWorkspaceKeyForUser.get(row.workspace_id, userId) !== undefined;
}

/** Remove an attachment's object. Resolves to whether it is gone (a missing object is gone). */
export function removeObject(row: AttachmentRow): boolean {
  if (row.storage !== 'local') return false; // a bucket object is removed by the cleanup credential (step 4)
  const target = localPath(row);
  if (!target) return true;
  for (const file of [target, partialPath(target)]) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

/**
 * Remove what was never confirmed or was deleted: `pending` rows older than an hour with their
 * objects, and `deleted` rows once their objects are gone. Pending rows hold no usage, so nothing is
 * given back. A bucket's object is removed with the cleanup credential, and a row whose object cannot
 * be removed now stays for the next run. Returns how many rows it dropped.
 */
export async function cleanupAttachments(now = Date.now()): Promise<number> {
  let dropped = 0;
  const stale = registryStmts.listStalePendingAttachments.all(now - PENDING_MAX_AGE_MS) as AttachmentRow[];
  const store = getObjectStore();
  for (const row of [...stale, ...(registryStmts.listDeletedAttachments.all() as AttachmentRow[])]) {
    let gone: boolean;
    if (row.storage === 's3') {
      try {
        if (!store?.delete) continue;
        await store.delete(row.storage_key);
        gone = true;
      } catch (err) {
        console.warn(`[attachments] could not remove ${row.storage_key}:`, err);
        continue;
      }
    } else {
      gone = removeObject(row);
    }
    if (!gone) continue;
    forgetAttachment(row.attachment_id);
    // A pending upload's bytes were held for it until its URL expired, which is long before this runs; a clock
    // that moved on (or a run of the job after a restart) must not leave the hold behind.
    releaseReservation(row.attachment_id);
    dropped++;
  }
  return dropped;
}

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** Clean up shortly after startup, then every ten minutes. The timers do not keep the process alive. */
export function scheduleAttachmentCleanup(): void {
  const run = (): void => {
    cleanupAttachments()
      .then((n) => { if (n > 0) console.log(`[attachments] removed ${n} unconfirmed or deleted attachment(s)`); })
      .catch((err) => console.warn('[attachments] cleanup failed:', err));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
