import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { registryStmts } from '../db/registry';
import type { UserRow } from '../db/registry';
import {
  attachmentsUsed, forgetUpload, getQuotaBytes, reconcileUserUsage, recordUpload, releaseReservation,
  remainingBytes, tryReserve,
} from '../lib/quota';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
// Per-type upload size limits, all configurable via environment variables.
const MAX_SIZE_BYTES        = (Number(process.env.UPLOAD_MAX_SIZE_MB)    || 10)  * 1024 * 1024;
const MAX_IMAGE_SIZE_BYTES  = (Number(process.env.MAX_IMAGE_UPLOAD_MB)   || 20)  * 1024 * 1024;
const MAX_VIDEO_SIZE_BYTES  = (Number(process.env.MAX_VIDEO_UPLOAD_MB)   || 50)  * 1024 * 1024;
const MAX_AUDIO_SIZE_BYTES  = (Number(process.env.MAX_AUDIO_UPLOAD_MB)   || 100) * 1024 * 1024;
// Multer enforces the stream-level cap at the highest of all limits;
// we do a post-upload MIME check to apply the correct per-type limit.
const MULTER_MAX_BYTES = Math.max(MAX_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES, MAX_AUDIO_SIZE_BYTES);

export const uploadsRouter = Router();

// All upload routes require authentication.
uploadsRouter.use(requireAuth);

/**
 * What a multipart body adds to the file's own bytes: its boundaries and part headers, a few hundred
 * bytes. `Content-Length` counts them, so a file that fits would be refused by a margin this size.
 */
const MULTIPART_ALLOWANCE_BYTES = 4096;

/** A workspace id as the client sends it: a uuid, but only the characters are checked. */
const WORKSPACE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The 413 every refused upload gets, so a client has one thing to recognise (docs/DISK-QUOTAS.md §4.1). */
function sendQuotaExceeded(res: Response, userId: string, limit: number): void {
  res.status(413).json({
    error: 'storage_quota_exceeded',
    message: 'Your storage limit is reached.',
    used: attachmentsUsed(userId),
    limit,
  });
}

/**
 * POST /api/uploads[?workspaceId=<id>]
 * Accepts multipart/form-data with a single `file` field.
 * Files are stored under DATA_DIR/uploads/<userId>/.
 * Returns { url: '/uploads/<userId>/<uuid>.<ext>' }
 * Accepts all MIME types (images and arbitrary file attachments).
 *
 * An account with a storage limit is refused with 413 `storage_quota_exceeded` before the file is
 * read when its declared size does not fit, and while it streams when it turns out not to. The
 * workspace is in the query string, not the form, because a form field is not known until the body
 * has been read, and the check has to come first. Until a workspace can have more than one member the
 * uploader is charged whatever the workspace is.
 */
uploadsRouter.post('/', (req: Request, res: Response) => {
  if (req.isDemo) {
    res.status(403).json({ error: 'File uploads are not available in demo mode' });
    return;
  }

  const user = registryStmts.getUserById.get(req.userId) as UserRow | undefined;

  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  if (workspaceId) {
    if (!WORKSPACE_ID.test(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspaceId' });
      return;
    }
    // A workspace nobody has a key for yet is not set up on the server (its first sync is under
    // way), so there is nothing to refuse; one that has members is not the caller's to charge to.
    const { count } = registryStmts.countWorkspaceKeys.get(workspaceId) as { count: number };
    if (count > 0 && !registryStmts.getWorkspaceKeyForUser.get(workspaceId, req.userId)) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }
  }

  // The limit, what is left under it, and the bytes this upload promises. An account that is not a
  // registered user (some tests) has no limit.
  const limit = user ? getQuotaBytes(user) : null;
  const remaining = remainingBytes(req.userId, limit);
  let promised = 0;
  if (limit !== null && remaining !== null) {
    const declared = Number(req.headers['content-length']);
    // A body of unknown length promises the most the stream may take. One of known length promises its
    // file: the framing is not the account's storage, and the stream is cut at what is left anyway.
    promised = Number.isFinite(declared) && declared > 0
      ? Math.max(0, declared - MULTIPART_ALLOWANCE_BYTES)
      : Math.min(MULTER_MAX_BYTES, remaining);
    if (!tryReserve(req.userId, limit, promised)) {
      sendQuotaExceeded(res, req.userId, limit);
      return;
    }
  }
  // Given back once, on whichever way out comes first: the file stored, an error, or a client that left.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (limit !== null) releaseReservation(req.userId, limit, promised);
  };
  res.once('close', release);

  // Lazily create the user's upload directory on first upload.
  const userUploadsDir = path.join(DATA_DIR, 'uploads', req.userId);
  fs.mkdirSync(userUploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, userUploadsDir),
    filename: (_r, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  // The stream is cut at the most any type may be, or at what the account has left, if less.
  const cap = remaining === null ? MULTER_MAX_BYTES : Math.min(MULTER_MAX_BYTES, remaining);
  const upload = multer({
    storage,
    limits: { fileSize: cap },
  }).single('file');

  upload(req, res, (err) => {
    if (err) {
      release();
      const cutByQuota = limit !== null && remaining !== null && remaining < MULTER_MAX_BYTES
        && (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      if (cutByQuota) {
        sendQuotaExceeded(res, req.userId, limit);
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      release();
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Post-upload size check: apply the correct per-type limit.
    const isVideo = req.file.mimetype.startsWith('video/');
    const isAudio = req.file.mimetype.startsWith('audio/');
    const isImage = req.file.mimetype.startsWith('image/');
    const effectiveLimit = isVideo ? MAX_VIDEO_SIZE_BYTES
                         : isAudio ? MAX_AUDIO_SIZE_BYTES
                         : isImage ? MAX_IMAGE_SIZE_BYTES
                         : MAX_SIZE_BYTES;
    if (req.file.size > effectiveLimit) {
      release();
      fs.unlinkSync(req.file.path);
      const limitMb = Math.round(effectiveLimit / (1024 * 1024));
      res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB.` });
      return;
    }

    recordUpload({ userId: req.userId, workspaceId, fileId: req.file.filename, size: req.file.size });
    release();

    const url = `/uploads/${req.userId}/${req.file.filename}`;
    res.status(201).json({ url });
  });
});

/**
 * GET /api/uploads
 * The caller's own uploads, from the ledger: `{ files: [{ id, size, workspaceId }] }`, `id` being the name
 * the file has in the caller's folder (the last segment of its URL). What a client compares with the
 * files its deleted media documents name, to remove those the server still holds
 * (docs/DISK-QUOTAS.md §4.4). An account never measured is measured first, so its files are listed.
 */
uploadsRouter.get('/', (req: Request, res: Response) => {
  attachmentsUsed(req.userId);
  const rows = registryStmts.listAttachmentsByUploader.all(req.userId) as { file_id: string; workspace_id: string; size_bytes: number }[];
  res.json({ files: rows.map((r) => ({ id: r.file_id, size: r.size_bytes, workspaceId: r.workspace_id })) });
});

/**
 * DELETE /api/uploads/:fileId
 * Removes one of the caller's own uploads, by the name it has in their directory (the last segment of
 * its URL), and gives its bytes back. 404 when there is no such file.
 */
uploadsRouter.delete('/:fileId', (req: Request, res: Response) => {
  if (req.isDemo) {
    res.status(403).json({ error: 'File uploads are not available in demo mode' });
    return;
  }
  const { fileId } = req.params;
  // A name made of the characters an upload's name has, so it cannot name a path.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileId)) {
    res.status(400).json({ error: 'Invalid file id' });
    return;
  }

  let removed = false;
  try {
    fs.unlinkSync(path.join(DATA_DIR, 'uploads', req.userId, fileId));
    removed = true;
  } catch {
    // Not on the disk; the ledger may still hold a row for it.
  }
  const forgotten = forgetUpload(req.userId, fileId);
  if (!removed && !forgotten) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  // A file the ledger did not know yet (never reconciled) is counted out by measuring again.
  if (removed && !forgotten) reconcileUserUsage(req.userId);
  res.status(204).send();
});
