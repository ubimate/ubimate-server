import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
const MAX_SIZE_BYTES = (Number(process.env.UPLOAD_MAX_SIZE_MB) || 10) * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export const uploadsRouter = Router();

// All upload routes require authentication.
uploadsRouter.use(requireAuth);

/**
 * POST /api/uploads
 * Accepts multipart/form-data with a single `file` field.
 * Files are stored under DATA_DIR/uploads/<userId>/.
 * Returns { url: '/uploads/<userId>/<uuid>.<ext>' }
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
    limits: { fileSize: MAX_SIZE_BYTES },
    fileFilter: (_r, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
    },
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
    const url = `/uploads/${req.userId}/${req.file.filename}`;
    res.status(201).json({ url });
  });
});
