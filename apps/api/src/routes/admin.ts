import { Router, Request, Response } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { JWT_SECRET } from '../middleware/auth';
import {
  requireAdminConfigured,
  requireAdmin,
  verifyAdminCredentials,
  getAdminIdentity,
  ADMIN_TOKEN_EXPIRES_IN,
} from '../middleware/adminAuth';
import { registryStmts } from '../db/registry';
import type { InvitationRow } from '../db/registry';
import { sendInvitationEmail, smtpConfigured } from '../email';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
const INVITATION_TTL_MS = (Number(process.env.INVITATION_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;

export const adminRouter = Router();

// All admin routes require admin to be configured, except where we override.
adminRouter.use(requireAdminConfigured);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeInvitationStatus(row: InvitationRow): 'accepted' | 'elapsed' | 'pending' {
  if (row.accepted_at != null) return 'accepted';
  if (row.created_at < Date.now() - INVITATION_TTL_MS) return 'elapsed';
  return 'pending';
}

function formatInvitation(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    token: row.token,
    status: computeInvitationStatus(row),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/login
// ---------------------------------------------------------------------------
adminRouter.post('/login', adminLoginLimiter, async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const valid = await verifyAdminCredentials(username, password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }

  const token = jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET, {
    expiresIn: ADMIN_TOKEN_EXPIRES_IN,
  });

  res.json({ token });
});

// ---------------------------------------------------------------------------
// All routes below require admin JWT
// ---------------------------------------------------------------------------
adminRouter.use(requireAdmin);

// ---------------------------------------------------------------------------
// GET /api/admin/me
// ---------------------------------------------------------------------------
adminRouter.get('/me', (_req: Request, res: Response) => {
  res.json(getAdminIdentity());
});

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
adminRouter.get('/users', (_req: Request, res: Response) => {
  const rows = registryStmts.listUsers.all() as {
    id: string;
    email: string;
    properties: string;
    status: string;
    created_at: number;
  }[];

  const users = rows.map((row) => {
    let diskUsageBytes = 0;

    // Count user's SQLite DB + WAL/SHM files
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        diskUsageBytes += fs.statSync(path.join(DATA_DIR, 'users', `${row.id}.db${suffix}`)).size;
      } catch {
        // File doesn't exist — that's fine.
      }
    }

    // Count uploaded files in DATA_DIR/uploads/<userId>/
    const uploadsDir = path.join(DATA_DIR, 'uploads', row.id);
    try {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        try {
          diskUsageBytes += fs.statSync(path.join(uploadsDir, file)).size;
        } catch {
          // Skip files we can't stat.
        }
      }
    } catch {
      // Directory doesn't exist — user has no uploads.
    }

    let properties: Record<string, unknown> = {};
    try {
      properties = JSON.parse(row.properties);
    } catch {
      // Malformed JSON — return empty object.
    }

    return {
      id: row.id,
      email: row.email,
      properties,
      status: row.status,
      created_at: row.created_at,
      disk_usage_bytes: diskUsageBytes,
    };
  });

  res.json(users);
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id
// ---------------------------------------------------------------------------
adminRouter.delete('/users/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const row = registryStmts.listUsers.all().find((u: any) => u.id === id);
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Write a tombstone file preserving the deleted user's metadata.
  const tombstone = {
    ...(row as Record<string, unknown>),
    deleted_at: Date.now(),
  };
  const tombstonePath = path.join(DATA_DIR, 'users', `${id}_tombstone.json`);
  fs.writeFileSync(tombstonePath, JSON.stringify(tombstone, null, 2));

  registryStmts.deleteUser.run(id);

  res.status(204).send();
});

// ---------------------------------------------------------------------------
// GET /api/admin/invitations
// ---------------------------------------------------------------------------
adminRouter.get('/invitations', (_req: Request, res: Response) => {
  const rows = registryStmts.listInvitations.all() as InvitationRow[];
  res.json(rows.map(formatInvitation));
});

// ---------------------------------------------------------------------------
// POST /api/admin/invitations
// ---------------------------------------------------------------------------
adminRouter.post('/invitations', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check for existing pending invitation for this email
  const existing = registryStmts.getPendingInvitationByEmail.get(normalizedEmail) as InvitationRow | undefined;
  if (existing && computeInvitationStatus(existing) === 'pending') {
    res.status(409).json({ error: 'A pending invitation for this email already exists' });
    return;
  }

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();

  registryStmts.insertInvitation.run({ id, token, email: normalizedEmail, created_at: now });

  // Attempt to send email; don't fail the request if email sending fails
  let emailSent = false;
  if (smtpConfigured) {
    try {
      await sendInvitationEmail(normalizedEmail, token);
      emailSent = true;
    } catch (err) {
      console.error('[admin] Failed to send invitation email:', err);
    }
  }

  const row = registryStmts.getInvitationById.get(id) as InvitationRow;
  const response = formatInvitation(row);

  if (!emailSent) {
    res.status(smtpConfigured ? 502 : 201).json({
      ...response,
      warning: smtpConfigured
        ? 'Email could not be sent — share the token manually'
        : 'SMTP not configured — share the token manually',
    });
    return;
  }

  res.status(201).json(response);
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/invitations/:id
// ---------------------------------------------------------------------------
adminRouter.delete('/invitations/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const row = registryStmts.getInvitationById.get(id) as InvitationRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }

  if (row.accepted_at != null) {
    res.status(409).json({ error: 'Cannot delete an accepted invitation' });
    return;
  }

  registryStmts.deleteInvitation.run(id);
  res.status(204).send();
});
