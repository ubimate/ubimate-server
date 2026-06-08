import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserDb } from '../db/userDb';
import type { UserDbHandle } from '../db/userDb';

export const JWT_SECRET = process.env.JWT_SECRET ?? (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production');
  }
  console.warn('[auth] JWT_SECRET not set — using insecure default (dev only)');
  return 'ubimate-dev-secret-change-in-production';
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
      /** True when the session belongs to an ephemeral demo account. */
      isDemo: boolean;
    }
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Verifies the JWT from the HttpOnly session cookie OR an Authorization: Bearer header.
 * The cookie is the preferred source (browser). The Bearer header is used by the
 * Tauri desktop app, which cannot rely on the WebView cookie jar for cross-origin
 * requests to the cloud API.
 * On success, attaches req.userId, req.userEmail, and req.userDbHandle.
 * On failure, responds with 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Cookie is the primary source — HttpOnly, inaccessible to JS.
  const cookieToken: string | undefined = (req.cookies as Record<string, string>)?.nf_session;

  // Bearer header is the fallback for Tauri / API clients.
  const authHeader: string | undefined = req.headers.authorization;
  const bearerToken: string | undefined =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  const token = cookieToken ?? bearerToken;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; is_demo?: boolean };
    req.userId = payload.sub;
    req.userEmail = payload.email;
    req.isDemo = payload.is_demo === true;
    req.userDbHandle = getUserDb(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
