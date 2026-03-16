import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';

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
 * POST /api/uploads
 * Accepts multipart/form-data with a single `file` field.
 * Files are stored under DATA_DIR/uploads/<userId>/.
 * Returns { url: '/uploads/<userId>/<uuid>.<ext>' }
 * Accepts all MIME types (images and arbitrary file attachments).
 */
uploadsRouter.post('/', (req: Request, res: Response) => {
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

  const upload = multer({
    storage,
    limits: { fileSize: MULTER_MAX_BYTES },
  }).single('file');

  upload(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
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
      fs.unlinkSync(req.file.path);
      const limitMb = Math.round(effectiveLimit / (1024 * 1024));
      res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB.` });
      return;
    }

    const url = `/uploads/${req.userId}/${req.file.filename}`;
    res.status(201).json({ url });
  });
});
