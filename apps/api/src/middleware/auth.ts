import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserDb } from '../db/userDb';
import type { UserDbHandle } from '../db/userDb';

export const JWT_SECRET = process.env.JWT_SECRET ?? (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production');
  }
  console.warn('[auth] JWT_SECRET not set — using insecure default (dev only)');
  return 'sovernote-dev-secret-change-in-production';
})();

export const JWT_EXPIRES_IN = '7d';

// ---------------------------------------------------------------------------
// Express Request augmentation
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      userEmail: string;
      userDbHandle: UserDbHandle;
    }
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Verifies the JWT from the HttpOnly session cookie.
 * On success, attaches req.userId, req.userEmail, and req.userDbHandle.
 * On failure, responds with 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Cookie is the primary source — HttpOnly, inaccessible to JS.
  const cookieToken: string | undefined = (req.cookies as Record<string, string>)?.nf_session;

  if (!cookieToken) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = cookieToken;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };
    req.userId = payload.sub;
    req.userEmail = payload.email;
    req.userDbHandle = getUserDb(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
