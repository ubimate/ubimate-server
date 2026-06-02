import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { JWT_SECRET } from './auth';

// ---------------------------------------------------------------------------
// Admin credentials from environment
// ---------------------------------------------------------------------------

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

export const adminConfigured = !!(ADMIN_USERNAME && ADMIN_PASSWORD && ADMIN_EMAIL);

if (!adminConfigured) {
  console.warn('[admin] ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL not set — admin routes disabled');
}

// Hash the admin password once at startup for in-memory comparison.
let adminPasswordHash: string | null = null;
if (adminConfigured && ADMIN_PASSWORD) {
  // bcrypt.hashSync is acceptable here — runs once at startup, not in a request path.
  adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
}

export const ADMIN_TOKEN_EXPIRES_IN = '8h';

export function getAdminIdentity() {
  return { username: ADMIN_USERNAME!, email: ADMIN_EMAIL! };
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  if (!adminConfigured || !adminPasswordHash) return false;
  if (username !== ADMIN_USERNAME) {
    // Constant-time: still run bcrypt compare against dummy hash to prevent timing attacks
    await bcrypt.compare(password, '$2a$12$invalidhashfortimingnormalization');
    return false;
  }
  return bcrypt.compare(password, adminPasswordHash);
}

// ---------------------------------------------------------------------------
// Request augmentation
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminRole?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Rejects requests when admin is not configured (503).
 */
export function requireAdminConfigured(_req: Request, res: Response, next: NextFunction): void {
  if (!adminConfigured) {
    res.status(503).json({ error: 'Admin account not configured' });
    return;
  }
  next();
}

/**
 * Verifies the admin JWT from the Authorization: Bearer header.
 * Rejects non-admin JWTs with 401.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!adminConfigured) {
    res.status(503).json({ error: 'Admin account not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: 'Admin authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; role?: string };
    if (payload.role !== 'admin') {
      res.status(401).json({ error: 'Admin authentication required' });
      return;
    }
    req.adminRole = payload.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}
