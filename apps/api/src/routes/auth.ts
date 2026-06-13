import { Router, Request, Response } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { ed25519 } from '@noble/curves/ed25519.js';
import { registryStmts, parseUserProperties, resolvePrimaryWorkspaceId } from '../db/registry';
import type { UserRow, InvitationRow, WorkspaceKeyRow } from '../db/registry';
import { JWT_SECRET, JWT_EXPIRES_IN, requireAuth } from '../middleware/auth';
import { getUserDb } from '../db/userDb';
import type { AuthPayload } from '@ubimate/types';
import { trackEvent } from '../analytics';

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
// Challenge-response nonce store (in-memory, ZK auth)
// ---------------------------------------------------------------------------

/** TTL for a one-time nonce: 30 seconds. */
const NONCE_TTL_MS = 30_000;

interface NonceEntry {
  /** 64-char lowercase hex (32 random bytes). */
  nonce: string;
  /** Unix ms expiry. */
  expiresAt: number;
  /** Consumed on first verification attempt (prevents replay within the TTL window). */
  consumed: boolean;
}

/** Keyed by normalised email. */
const nonceStore = new Map<string, NonceEntry>();

/** Remove entries whose TTL has elapsed. Called lazily before every store write. */
function cleanupNonces(): void {
  const now = Date.now();
  for (const [email, entry] of nonceStore.entries()) {
    if (entry.expiresAt < now) nonceStore.delete(email);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/** 30 days in milliseconds (for maxAge when remember_me = true). */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Set the session cookie.
 * @param remember - when true (default) the cookie persists for 30 days;
 *                   when false a session-scoped cookie is issued (no maxAge)
 *                   so it expires when the browser closes.
 */
function setSessionCookie(res: Response, token: string, remember = true): void {
  const opts = remember ? { ...COOKIE_BASE, maxAge: THIRTY_DAYS_MS } : COOKIE_BASE;
  res.cookie(SESSION_COOKIE, token, opts);
}

// ---------------------------------------------------------------------------
// GET /api/auth/challenge — issue a single-use nonce for Ed25519 sign-in
// ---------------------------------------------------------------------------
authRouter.get('/challenge', authLimiter, (req: Request, res: Response) => {
  const email = req.query['email'];
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }

  cleanupNonces();

  const normalizedEmail = email.trim().toLowerCase();
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonceStore.set(normalizedEmail, { nonce, expiresAt, consumed: false });

  // has_zk_keys is retained for backward-compatible clients.
  const user = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;
  const hasZkKeys = !!(user?.public_key);

  res.json({ nonce, expires_at: expiresAt, has_zk_keys: hasZkKeys });
});

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
authRouter.post('/register', authLimiter, async (req: Request, res: Response) => {
  const { email, name, invitationToken, publicKey, initialWorkspaceId, initialWrappedWorkspaceKey } = req.body as AuthPayload & {
    name?: string;
    invitationToken?: string;
    publicKey?: string;
    initialWorkspaceId?: string;
    initialWrappedWorkspaceKey?: string;
  };

  if (name !== undefined && (typeof name !== 'string' || name.trim().length > 100)) {
    res.status(400).json({ error: 'Name must not exceed 100 characters' });
    return;
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }
  if (!publicKey || typeof publicKey !== 'string') {
    res.status(400).json({ error: 'publicKey is required' });
    return;
  }
  if (!initialWorkspaceId || typeof initialWorkspaceId !== 'string') {
    res.status(400).json({ error: 'initialWorkspaceId is required' });
    return;
  }
  if (!initialWrappedWorkspaceKey || typeof initialWrappedWorkspaceKey !== 'string') {
    res.status(400).json({ error: 'initialWrappedWorkspaceKey is required' });
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
      // Prefer explicit expires_at; fall back to legacy created_at + TTL check.
      const expiredAt = matchedInvitation.expires_at ?? (matchedInvitation.created_at + INVITATION_TTL_MS);
      if (Date.now() > expiredAt) {
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

  const userId = randomUUID();
  const now = Date.now();

  const properties: Record<string, unknown> = name?.trim() ? { name: name.trim() } : {};
  registryStmts.createUser.run({
    id: userId,
    email: normalizedEmail,
    properties: JSON.stringify(properties),
    created_at: now,
    status: 'active',
    public_key: publicKey,
    wrapped_content_key: null,
    user_type: 'regular',
  });
  trackEvent('user-created', { type: 'regular' });

  // Create the initial workspace document in the user's per-user DB.
  const userDb = getUserDb(userId);
  userDb.stmts.insertDocument.run({
    id: initialWorkspaceId,
    parent_id: null,
    type: 'workspace',
    position: 'a0',
    properties: '{}',
    created_at: now,
    updated_at: now,
    last_struct_ts: now,
    status: 0,
    status_timestamp: null,
    last_properties_ts: now,
  });

  // Persist the user's sealed copy of the workspace content key.
  registryStmts.insertWorkspaceKey.run({
    workspace_id: initialWorkspaceId,
    user_id: userId,
    wrapped_key: initialWrappedWorkspaceKey,
    granted_at: now,
  });

  // Mark this initial workspace as the user's protected "home" — it can never
  // be deleted and is the default target for quick-capture notes.
  registryStmts.setPrimaryWorkspaceId.run({ id: userId, primary_workspace_id: initialWorkspaceId });

  // Mark invitation as accepted
  if (matchedInvitation && matchedInvitation.accepted_at == null) {
    registryStmts.markInvitationAccepted.run(now, matchedInvitation.id);
  }

  const token = jwt.sign({ sub: userId, email: normalizedEmail }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  setSessionCookie(res, token);
  res.status(201).json({
    user: { id: userId, email: normalizedEmail, properties, created_at: now, public_key: publicKey, primary_workspace_id: initialWorkspaceId },
    workspace_keys: [{ workspace_id: initialWorkspaceId, wrapped_key: initialWrappedWorkspaceKey }],
    ...(matchedInvitation?.sender_public_key && matchedInvitation?.sender_signature
      ? {
          invitation: {
            sender_public_key: matchedInvitation.sender_public_key,
            sender_signature: matchedInvitation.sender_signature,
            expires_at: matchedInvitation.expires_at,
          },
        }
      : {}),
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
//
// Strict ZK authentication path only:
//   { email, nonce, signature } where signature = base64(Ed25519.sign(nonce_utf8, sk))
// ---------------------------------------------------------------------------
authRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { email, signature, nonce: clientNonce, remember_me } = req.body as {
    email?: string;
    signature?: string;
    nonce?: string;
    remember_me?: boolean;
  };
  const remember = remember_me === true;

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();

  if (!clientNonce || typeof clientNonce !== 'string' || typeof signature !== 'string') {
    res.status(400).json({ error: 'nonce and signature are required' });
    return;
  }

  const user = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;

  if (!user || !user.public_key) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const stored = nonceStore.get(normalizedEmail);
  if (!stored || stored.consumed || stored.expiresAt < Date.now() || stored.nonce !== clientNonce) {
    res.status(401).json({ error: 'Invalid or expired nonce' });
    return;
  }
  stored.consumed = true;

  let valid = false;
  try {
    const sigBytes = Buffer.from(signature, 'base64');
    const pubKeyBytes = Buffer.from(user.public_key, 'base64');
    const msgBytes = Buffer.from(clientNonce, 'utf8');
    valid = ed25519.verify(sigBytes, msgBytes, pubKeyBytes);
  } catch {
    valid = false;
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (user.status !== 'active') {
    res.status(403).json({ error: 'Account is not active' });
    return;
  }

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  setSessionCookie(res, token, remember);
  const workspaceKeys = (registryStmts.listWorkspaceKeysForUser.all(user.id) as WorkspaceKeyRow[]).map(k => ({
    workspace_id: k.workspace_id,
    wrapped_key: k.wrapped_key,
  }));
  res.json({
    user: { id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at, public_key: user.public_key, primary_workspace_id: resolvePrimaryWorkspaceId(user.id) },
    workspace_keys: workspaceKeys,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login/token — for Tauri / API clients
//
// Same logic as /login but returns the JWT in the response body
// instead of setting an HttpOnly cookie.  Used by the Tauri desktop app,
// which cannot rely on the WebView cookie jar for cross-origin requests.
// ---------------------------------------------------------------------------
authRouter.post('/login/token', authLimiter, async (req: Request, res: Response) => {
  const { email, signature, nonce: clientNonce } = req.body as {
    email?: string;
    signature?: string;
    nonce?: string;
  };

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();

  if (!clientNonce || typeof clientNonce !== 'string' || typeof signature !== 'string') {
    res.status(400).json({ error: 'nonce and signature are required' });
    return;
  }

  const user = registryStmts.getUserByEmail.get(normalizedEmail) as UserRow | undefined;

  if (!user || !user.public_key) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const stored = nonceStore.get(normalizedEmail);
  if (!stored || stored.consumed || stored.expiresAt < Date.now() || stored.nonce !== clientNonce) {
    res.status(401).json({ error: 'Invalid or expired nonce' });
    return;
  }
  stored.consumed = true;

  let valid = false;
  try {
    const sigBytes = Buffer.from(signature, 'base64');
    const pubKeyBytes = Buffer.from(user.public_key, 'base64');
    const msgBytes = Buffer.from(clientNonce, 'utf8');
    valid = ed25519.verify(sigBytes, msgBytes, pubKeyBytes);
  } catch {
    valid = false;
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
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
    user: { id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at, public_key: user.public_key, primary_workspace_id: resolvePrimaryWorkspaceId(user.id) },
    workspace_keys: (registryStmts.listWorkspaceKeysForUser.all(user.id) as WorkspaceKeyRow[]).map(k => ({
      workspace_id: k.workspace_id,
      wrapped_key: k.wrapped_key,
    })),
    token,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-request
//
// Deprecated: password-hash reset flow removed with legacy auth.
// ---------------------------------------------------------------------------
authRouter.post('/reset-request', authLimiter, (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Password reset is no longer supported. Use key-based account recovery from a trusted device.' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-confirm
//
// Deprecated: password-hash reset flow removed with legacy auth.
// ---------------------------------------------------------------------------
authRouter.post('/reset-confirm', authLimiter, (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Password reset is no longer supported. Use key-based account recovery from a trusted device.' });
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
  res.json({
    user: { id: user.id, email: user.email, properties: parseUserProperties(user), created_at: user.created_at, public_key: user.public_key ?? null, primary_workspace_id: resolvePrimaryWorkspaceId(user.id) },
    workspace_keys: (registryStmts.listWorkspaceKeysForUser.all(user.id) as WorkspaceKeyRow[]).map(k => ({
      workspace_id: k.workspace_id,
      wrapped_key: k.wrapped_key,
    })),
  });
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

