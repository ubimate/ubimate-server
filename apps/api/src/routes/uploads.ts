import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const UPLOADS_DIR = path.join(process.env.DATA_DIR ?? path.join(__dirname, '../../data'), 'uploads');
const MAX_SIZE_BYTES = (Number(process.env.UPLOAD_MAX_SIZE_MB) || 10) * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Ensure the uploads directory exists at startup.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const uuid = crypto.randomUUID();
    cb(null, `${uuid}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

export const uploadsRouter = Router();

/**
 * POST /api/uploads
 * Accepts multipart/form-data with a single `file` field.
 * Returns { url: '/uploads/<uuid>.<ext>' }
 */
uploadsRouter.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }
  const url = `/uploads/${req.file.filename}`;
  res.status(201).json({ url });
});
