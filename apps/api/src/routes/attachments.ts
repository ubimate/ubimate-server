/**
 * /api/attachments — encrypted attachments in local mode (docs/ATTACHMENT-ENCRYPTION.md 6).
 *
 * The client encrypts the file (format 2, packages/crypto) and wraps its key; the server stores the
 * ciphertext and the wrapped key and checks Space membership on every read. It never sees a name, a
 * MIME type or a key. The flow is presign, PUT the bytes, confirm; reads go through the batched
 * `resolve`, whose answer carries the URL and the wrapped key.
 */
import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { requireAuth } from '../middleware/auth';
import { getObjectStore } from '../lib/objectStore';
import { currentKeyVersion, registryStmts } from '../db/registry';
import type { AttachmentKind, AttachmentRow, UserRow } from '../db/registry';
import {
  attachmentsUsed, chargedAccount, confirmAttachment, forgetAttachment, getQuotaBytes, releaseReservation, retireAttachment, tryReserve,
} from '../lib/quota';
import {
  BLOB_OVERHEAD_BYTES, bucketStorageKey, canRead, localPath, localStorageKey, maxPlaintextBytes, partialPath,
  PRESIGN_EXPIRY_GET_MS, PRESIGN_EXPIRY_PUT_MS, removeObject, WRAPPED_KEY_CHARS,
} from '../lib/attachments';

export const attachmentsRouter = Router();

/** Express 4 does not catch what an async handler rejects with: this answers 500 for it, so a failing bucket is a response. */
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response): void => {
  handler(req, res).catch((err) => {
    console.warn(`[attachments] ${req.method} ${req.path} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Storage error' });
  });
};

attachmentsRouter.use(requireAuth);

/** An id as the client makes it (a uuid); only the characters are checked, and they cannot name a path. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
const KINDS: readonly AttachmentKind[] = ['image', 'video', 'audio', 'file'];
const WRAPPED_KEY = new RegExp(`^[A-Za-z0-9_-]{${WRAPPED_KEY_CHARS}}$`);
const MAX_RESOLVE_IDS = 100;

/** The 413 every upload over the account's limit gets, so a client has one thing to recognise (docs/DISK-QUOTAS.md §4.1). */
function sendQuotaExceeded(res: Response, userId: string, limit: number, revealFigures = true): void {
  // Someone uploading into another account's Space is not told that account's usage or limit.
  if (!revealFigures) {
    res.status(413).json({ error: 'storage_quota_exceeded', message: 'The storage limit is reached.' });
    return;
  }
  res.status(413).json({
    error: 'storage_quota_exceeded',
    message: 'Your storage limit is reached.',
    used: attachmentsUsed(userId),
    limit,
  });
}

/** The caller's own attachment in the given state, or a 404 sent. */
function ownPending(req: Request, res: Response): AttachmentRow | null {
  const row = ID.test(req.params.id)
    ? registryStmts.getAttachment.get(req.params.id) as AttachmentRow | undefined
    : undefined;
  if (!row || row.uploader_user_id !== req.userId || row.status !== 'pending') {
    res.status(404).json({ error: 'No such pending attachment' });
    return null;
  }
  return row;
}

/**
 * POST /api/attachments/presign — see 6.1. Reserves the bytes against the quota, records a `pending`
 * row and says where to PUT them.
 */
attachmentsRouter.post('/presign', asyncRoute(async (req: Request, res: Response) => {
  const { workspaceId, attachmentId, size, kind, keyVersion, wrappedKey } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) return void res.status(400).json({ error: 'Invalid workspaceId' });
  if (typeof attachmentId !== 'string' || !ID.test(attachmentId)) return void res.status(400).json({ error: 'Invalid attachmentId' });
  if (typeof kind !== 'string' || !KINDS.includes(kind as AttachmentKind)) return void res.status(400).json({ error: 'Invalid kind' });
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < BLOB_OVERHEAD_BYTES) return void res.status(400).json({ error: 'Invalid size' });
  if (typeof keyVersion !== 'number' || !Number.isSafeInteger(keyVersion) || keyVersion < 1) return void res.status(400).json({ error: 'Invalid keyVersion' });
  if (typeof wrappedKey !== 'string' || !WRAPPED_KEY.test(wrappedKey)) return void res.status(400).json({ error: 'Invalid wrappedKey' });

  const user = registryStmts.getUserById.get(req.userId) as UserRow | undefined;
  if (!user) return void res.status(401).json({ error: 'Unknown account' });

  // A Space nobody has a key for is not set up on the server yet (its first sync is under way), so there
  // is nothing to refuse; one that has members is not the caller's to put files in.
  const { count } = registryStmts.countWorkspaceKeys.get(workspaceId) as { count: number };
  if (count > 0 && !registryStmts.getWorkspaceKeyForUser.get(workspaceId, req.userId)) {
    return void res.status(403).json({ error: 'Not a member of this workspace' });
  }

  const existing = registryStmts.getAttachment.get(attachmentId) as AttachmentRow | undefined;
  if (existing && (existing.uploader_user_id !== req.userId || existing.workspace_id !== workspaceId)) {
    return void res.status(409).json({ error: 'id_taken' });
  }
  // An earlier confirm whose answer was lost: the client treats it as done.
  if (existing?.status === 'confirmed') return void res.status(409).json({ error: 'already_uploaded' });

  const current = currentKeyVersion(workspaceId);
  if (keyVersion !== current) return void res.status(409).json({ error: 'key_rotated', currentVersion: current });

  const cap = maxPlaintextBytes(kind as AttachmentKind) + BLOB_OVERHEAD_BYTES;
  if (size > cap) {
    const limitMb = Math.round(maxPlaintextBytes(kind as AttachmentKind) / (1024 * 1024));
    return void res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB.` });
  }

  const now = Date.now();
  const expiresAt = now + PRESIGN_EXPIRY_PUT_MS;
  // Charged to the owner of the Space, whoever uploads (a guest's files count against the host).
  const chargedId = chargedAccount(workspaceId, req.userId);
  const charged = chargedId === req.userId ? user : registryStmts.getUserById.get(chargedId) as UserRow;
  const limit = getQuotaBytes(charged);
  if (!tryReserve(chargedId, limit, size, attachmentId, expiresAt)) {
    return void sendQuotaExceeded(res, chargedId, limit as number, chargedId === req.userId);
  }

  // Where the bytes go: the bucket when one is configured (a PUT straight to it, signed for exactly this size
  // and type), the node's disk otherwise (a PUT to this API).
  const store = getObjectStore();
  const storage = store ? 's3' : 'local';
  const storageKey = store ? bucketStorageKey(attachmentId) : localStorageKey(req.userId, attachmentId);
  let plan: { uploadUrl: string; headers: Record<string, string> };
  if (store) {
    try {
      const signed = await store.presignPut(storageKey, size, 'application/octet-stream', Math.ceil(PRESIGN_EXPIRY_PUT_MS / 1000));
      plan = { uploadUrl: signed.url, headers: signed.headers };
    } catch (err) {
      releaseReservation(attachmentId);
      throw err;
    }
  } else {
    plan = { uploadUrl: `/api/attachments/${attachmentId}/content`, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } };
  }

  const fields = { attachment_id: attachmentId, kind, key_version: keyVersion, wrapped_key: wrappedKey, expected_size: size, created_at: now, storage, storage_key: storageKey, owner_user_id: chargedId };
  if (existing) {
    registryStmts.refreshPendingAttachment.run(fields);
  } else {
    registryStmts.insertPendingAttachment.run({ ...fields, workspace_id: workspaceId, uploader_user_id: req.userId });
  }

  res.json({ mode: storage, uploadUrl: plan.uploadUrl, headers: plan.headers, expiresAt });
}));

// Ids whose bytes are being written now: a second PUT for one of them is refused rather than interleaved.
const writing = new Set<string>();

/**
 * PUT /api/attachments/:id/content — the bytes, as a raw body, cut at the size declared at presign.
 * Written beside the final name and moved onto it when complete, so a reader never sees a part.
 */
attachmentsRouter.put('/:id/content', (req: Request, res: Response) => {
  const row = ownPending(req, res);
  if (!row) return;
  const target = localPath(row);
  if (row.storage !== 'local' || !target) return void res.status(404).json({ error: 'No such pending attachment' });
  if (Date.now() > row.created_at + PRESIGN_EXPIRY_PUT_MS) return void res.status(410).json({ error: 'upload_expired' });

  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) !== row.expected_size) {
    return void res.status(400).json({ error: 'size_mismatch' });
  }
  if (writing.has(row.attachment_id)) return void res.status(409).json({ error: 'upload_in_progress' });
  writing.add(row.attachment_id);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = partialPath(target);
  let received = 0;
  let overflow = false;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > row.expected_size) {
        overflow = true;
        return cb(new Error('Body is larger than declared'));
      }
      cb(null, chunk);
    },
  });
  pipeline(req, counter, fs.createWriteStream(part), (err) => {
    writing.delete(row.attachment_id);
    if (err) {
      try { fs.unlinkSync(part); } catch { /* never created */ }
      if (res.headersSent) return;
      if (overflow) return void res.status(400).json({ error: 'size_mismatch' });
      return void res.status(500).json({ error: 'Upload failed' });
    }
    fs.renameSync(part, target);
    res.status(204).end();
  });
});

/**
 * POST /api/attachments/:id/confirm — measures what was stored. A size other than the declared one
 * removes the object and the row and charges nothing; otherwise the owner is charged.
 */
attachmentsRouter.post('/:id/confirm', asyncRoute(async (req: Request, res: Response) => {
  // A confirm whose answer was lost is asked again: it is done, and says so without charging twice.
  const earlier = ID.test(req.params.id) ? registryStmts.getAttachment.get(req.params.id) as AttachmentRow | undefined : undefined;
  if (earlier?.status === 'confirmed' && earlier.uploader_user_id === req.userId) {
    return void res.json({ status: 'confirmed', size: earlier.size_bytes });
  }
  const row = ownPending(req, res);
  if (!row) return;
  let stored: number | null = null;
  if (row.storage === 's3') {
    const store = getObjectStore();
    if (!store) return void res.status(503).json({ error: 'Object storage is not configured' });
    stored = await store.head(row.storage_key);
  } else {
    const target = localPath(row);
    try {
      if (target) stored = fs.statSync(target).size;
    } catch {
      // Nothing stored.
    }
  }
  if (stored === null) return void res.status(400).json({ error: 'not_uploaded' });

  if (stored !== row.expected_size) {
    // Nothing is charged. A disk object is removed here; the API has no right to delete a bucket's, so that
    // row is marked and the cleanup job removes the object (a presign for the same id makes it pending again).
    if (removeObject(row)) forgetAttachment(row.attachment_id);
    else registryStmts.markAttachmentDeleted.run(row.attachment_id);
    releaseReservation(row.attachment_id);
    return void res.status(400).json({ error: 'size_mismatch' });
  }
  confirmAttachment(row, stored);
  releaseReservation(row.attachment_id);
  res.json({ status: 'confirmed', size: stored });
}));

/**
 * POST /api/attachments/resolve — `{ ids }` (1 to 100) answered per id with a URL and the wrapped key,
 * or `not_found` / `forbidden`. A pending or deleted attachment is not found.
 */
attachmentsRouter.post('/resolve', asyncRoute(async (req: Request, res: Response) => {
  const { ids } = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RESOLVE_IDS || !ids.every((id) => typeof id === 'string')) {
    return void res.status(400).json({ error: `ids must be 1 to ${MAX_RESOLVE_IDS} strings` });
  }
  const expiresAt = Date.now() + PRESIGN_EXPIRY_GET_MS;
  const store = getObjectStore();
  const items = await Promise.all((ids as string[]).map(async (id) => {
    const row = ID.test(id) ? registryStmts.getAttachment.get(id) as AttachmentRow | undefined : undefined;
    if (!row || row.status !== 'confirmed') return { id, error: 'not_found' };
    if (!canRead(req.userId, row)) return { id, error: 'forbidden' };
    // A bucket's object is read from the bucket, through a short-lived signed URL; a disk one through this API.
    let url = `/api/attachments/${id}/content`;
    if (row.storage === 's3') {
      if (!store) return { id, error: 'not_found' };
      url = await store.presignGet(row.storage_key, Math.ceil(PRESIGN_EXPIRY_GET_MS / 1000));
    }
    return {
      id, format: 2, url, expiresAt,
      keyVersion: row.key_version, wrappedKey: row.wrapped_key,
      // The Space the wrapping is bound to (its associated data), so the reader unwraps with the right key.
      workspaceId: row.workspace_id,
    };
  }));
  res.json({ items });
}));

/**
 * GET /api/attachments — the caller's own confirmed attachments, `{ files: [{ id, size, workspaceId }] }`.
 * What a client compares with the media documents it holds, to delete those no document names any more
 * (docs/DISK-QUOTAS.md §4.4). Not in the spec's route list, which removes the list this replaces.
 */
attachmentsRouter.get('/', (req: Request, res: Response) => {
  const rows = registryStmts.listAttachmentsByUploader.all(req.userId) as { attachment_id: string; workspace_id: string; size_bytes: number }[];
  res.json({ files: rows.map((r) => ({ id: r.attachment_id, size: r.size_bytes, workspaceId: r.workspace_id })) });
});

/** GET /api/attachments/:id/content — the ciphertext, after the membership check. */
attachmentsRouter.get('/:id/content', asyncRoute(async (req: Request, res: Response) => {
  const row = ID.test(req.params.id) ? registryStmts.getAttachment.get(req.params.id) as AttachmentRow | undefined : undefined;
  if (!row || row.status !== 'confirmed') return void res.status(404).json({ error: 'Not found' });
  if (!canRead(req.userId, row)) return void res.status(403).json({ error: 'Not a member of this workspace' });
  if (row.storage === 's3') {
    // For a caller that holds one id and wants one URL; the batch route is the normal path. A browser that
    // follows this redirect across origins sends the bucket a null Origin, so the client does not rely on it.
    const store = getObjectStore();
    if (!store) return void res.status(404).json({ error: 'Not found' });
    return void res.redirect(302, await store.presignGet(row.storage_key, Math.ceil(PRESIGN_EXPIRY_GET_MS / 1000)));
  }
  const target = localPath(row);
  if (!target) return void res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(target, { dotfiles: 'allow' }, (err) => {
    if (!err) return;
    if (res.headersSent || req.aborted) return void res.end();
    res.status(404).json({ error: 'Not found' });
  });
}));

/**
 * DELETE /api/attachments/:id — the uploader, or the owner of the Space it is in, removes an attachment, and
 * its bytes go back at once to the account that was charged for it.
 */
attachmentsRouter.delete('/:id', (req: Request, res: Response) => {
  const row = ID.test(req.params.id) ? registryStmts.getAttachment.get(req.params.id) as AttachmentRow | undefined : undefined;
  const owner = row ? (registryStmts.getSpaceOwner.get(row.workspace_id) as { owner_user_id: string } | undefined)?.owner_user_id : undefined;
  // Someone who may not delete it is told it is not there, as a non-member is told about a read.
  if (!row || row.status === 'deleted' || (row.uploader_user_id !== req.userId && owner !== req.userId)) {
    return void res.status(404).json({ error: 'Attachment not found' });
  }
  releaseReservation(row.attachment_id);
  // An object this process cannot remove (a bucket's) stays for the cleanup job; its bytes are given back now.
  if (removeObject(row)) forgetAttachment(row.attachment_id);
  else retireAttachment(row.attachment_id);
  res.status(204).send();
});
