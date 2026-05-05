import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { registryStmts, parseUserProperties } from '../db/registry';
import type { UserRow, InvitationRow } from '../db/registry';
import { JWT_SECRET, JWT_EXPIRES_IN, requireAuth } from '../middleware/auth';
import type { AuthPayload } from '@sovernote/types';

export const authRouter = Router();

// ---------------------------------------------------------------------------
// Invitation gating
// ---------------------------------------------------------------------------

const REQUIRE_INVITATION = process.env.REQUIRE_INVITATION !== 'false';
const INVITATION_TTL_MS = (Number(process.env.INVITATION_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limiting — brute-force protection for auth endpoints
// ---------------------------------------------------------------------------

/** 10 attempts per 15 minutes per IP on login/register (production only). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 10 : 1_000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** bcrypt silently truncates inputs at 72 bytes. Cap passwords to prevent two
 * different passwords from being accepted as equal. */
const MAX_PASSWORD_BYTES = 72;

/** Lowercase SHA-256 hex digest length. */
const SHA256_HEX_LEN = 64;

function isSha256Hex(value: string): boolean {
  return value.length === SHA256_HEX_LEN && /^[a-f0-9]+$/.test(value);
}

// Cookie name used for the session token.
const SESSION_COOKIE = 'nf_session';

// Cookie options shared by set and clear.
const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'strict' as const,
  // Secure flag: required in production (HTTPS). Omit in dev so plain http://localhost works.
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

/** 7 days in seconds (for maxAge). */
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: SEVEN_DAYS_S * 1000 });
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
authRouter.post('/register', authLimiter, async (req: Request, res: Response) => {
  const { email, password, name, invitationToken } = req.body as AuthPayload & { name?: string; invitationToken?: string };

  if (name !== undefined && (typeof name !== 'string' || name.trim().length > 100)) {
    res.status(400).json({ error: 'Name must not exceed 100 characters' });
    return;
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }
  if (!password || typeof password !== 'string' || !isSha256Hex(password)) {
    res.status(400).json({ error: 'Password hash is required' });
    return;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    res.status(400).json({ error: 'Invalid password hash size' });
    return;
  }

  // Invitation token validation
  let matchedInvitation: InvitationRow | undefined;
  if (invitationToken && typeof invitationToken === 'string') {
    matchedInvitation = registryStmts.getInvitationByToken.get(invitationToken) as InvitationRow | undefined;
    if (REQUIRE_INVITATION) {
      if (!matchedInvitation) {
        res.status(400).json({ error: 'Invalid invitation token' });
        return;
      }
      if (matchedInvitation.accepted_at != null) {
        res.status(400).json({ error: 'Invitation already used' });
        return;
      }
      if (matchedInvitation.created_at < Date.now() - INVITATION_TTL_MS) {
        res.status(400).json({ error: 'Invitation has elapsed' });
        return;
      }
    }
  } else if (REQUIRE_INVITATION) {
    res.status(400).json({ error: 'Invitation token is required' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();
  const now = Date.now();

  const properties: Record<string, unknown> = name?.trim() ? { name: name.trim() } : {};
  registryStmts.createUser.run({
    id: userId,
    email: normalizedEmail,
    properties: JSON.stringify(properties),
    password_hash: passwordHash,
    created_at: now,
    status: 'active',
  });

  // Mark invitation as accepted
  if (matchedInvitation && matchedInvitation.accepted_at == null) {
    registryStmts.markInvitationAccepted.run(now, matchedInvitation.id);
  }

  const token = jwt.sign({ sub: userId, email: normalizedEmail }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  setSessionCookie(res, token);
  res.status(201).json({ user: { id: userId, email: normalizedEmail, properties, created_at: now } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
authRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body as AuthPayload;

  if (!email || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'email and password hash are required' });
    return;
  }
  if (!isSha256Hex(password)) {
    res.status(400).json({ error: 'Invalid password hash format' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;

  // Use a constant-time comparison path to avoid user-enumeration via timing.
  const passwordHash = user?.password_hash ?? '$2a$12$invalidhashfortimingnormalization';
  const valid = await bcrypt.compare(password, passwordHash);

  if (!user || !valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (user.status !== 'active') {
    res.status(403).json({ error: 'Account is not active' });
    return;
  }

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  setSessionCookie(res, token);
  res.json({ user: { id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login/token — for Tauri / API clients
//
// Same validation logic as /login but returns the JWT in the response body
// instead of setting an HttpOnly cookie.  Used by the Tauri desktop app,
// which cannot rely on the WebView cookie jar for cross-origin requests.
// ---------------------------------------------------------------------------
authRouter.post('/login/token', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body as AuthPayload;

  if (!email || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'email and password hash are required' });
    return;
  }
  if (!isSha256Hex(password)) {
    res.status(400).json({ error: 'Invalid password hash format' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;

  const passwordHash = user?.password_hash ?? '$2a$12$invalidhashfortimingnormalization';
  const valid = await bcrypt.compare(password, passwordHash);

  if (!user || !valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (user.status !== 'active') {
    res.status(403).json({ error: 'Account is not active' });
    return;
  }

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  res.json({
    user: { id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at },
    token,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, COOKIE_BASE);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — verify session and return user profile
// ---------------------------------------------------------------------------
authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = registryStmts.getUserById.get(req.userId) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }
  res.json({ id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at });
});

// ---------------------------------------------------------------------------
// GET /api/auth/ws-token — issue a short-lived token for the Hocuspocus WS handshake
//
// Hocuspocus connects over WebSocket before any HTTP request is possible, so
// it cannot use the HttpOnly cookie. This endpoint exchanges the valid session
// cookie for a 60-second JWT used only for the WS `onAuthenticate` hook.
// ---------------------------------------------------------------------------
authRouter.get('/ws-token', requireAuth, (req: Request, res: Response) => {
  const wsToken = jwt.sign({ sub: req.userId, email: req.userEmail }, JWT_SECRET, {
    expiresIn: 60, // seconds
  });
  res.json({ token: wsToken });
});

