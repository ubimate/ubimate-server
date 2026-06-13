/**
 * Demo mode — ephemeral account provisioning.
 *
 * POST /api/demo/provision
 *   Creates a throwaway user + seeded workspace, issues a session-scoped JWT,
 *   and returns a DemoProvisionResponse. No ZK challenge required.
 *
 * Cleanup of expired demo accounts is handled server-side via
 * scheduleDemoCleanup() called from apps/api/src/index.ts.
 */
import { Router, Request, Response } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { trackEvent } from '../analytics';
import { issueCaptchaChallenge, verifyCaptchaPayload } from '../lib/captcha';
import { registryStmts, getUserType } from '../db/registry';
import type { UserRow } from '../db/registry';
import { closeUserDb, getUserDb } from '../db/userDb';
import { JWT_SECRET } from '../middleware/auth';
import { requireAuth } from '../middleware/auth';
import { seedDemoWorkspace } from '../db/demoSeeder';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEMO_MODE_ENABLED        = process.env.DEMO_MODE_ENABLED !== 'false';
const DEMO_EXPIRY_HOURS        = Number(process.env.DEMO_EXPIRY_HOURS)        || 24;
const DEMO_RATE_LIMIT_PER_HOUR = Number(process.env.DEMO_RATE_LIMIT_PER_HOUR) || 20;
// Use parseInt so that 0 is a valid (no-headroom) cap value.
const MAX_DEMO_USERS           = process.env.MAX_DEMO_USERS !== undefined
  ? parseInt(process.env.MAX_DEMO_USERS, 10)
  : 200;
const DEMO_FREETRIAL_DAYS      = Number(process.env.DEMO_FREETRIAL_DAYS)      || 14;
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');

const SESSION_COOKIE = 'nf_session';
const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

// ---------------------------------------------------------------------------
// Rate limiter — per IP, per hour
// ---------------------------------------------------------------------------

const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? DEMO_RATE_LIMIT_PER_HOUR : 1_000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many demo sessions from this IP, please try again later' },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const demoRouter = Router();

/**
 * GET /api/demo/challenge
 *
 * Issues a fresh ALTCHA proof-of-work challenge for the client to solve.
 * The challenge expires in 10 minutes; the solution must be submitted with
 * POST /api/demo/provision.
 */
demoRouter.get('/challenge', demoLimiter, async (_req: Request, res: Response) => {
  if (!DEMO_MODE_ENABLED) {
    res.status(403).json({ error: 'Demo mode is disabled' });
    return;
  }
  const challenge = await issueCaptchaChallenge();
  res.json(challenge);
});

/**
 * POST /api/demo/provision
 *
 * Creates an ephemeral demo account + workspace and issues a session-scoped
 * JWT cookie. Returns DemoProvisionResponse (defined in @ubimate/types).
 */
demoRouter.post('/provision', demoLimiter, async (req: Request, res: Response) => {
  if (!DEMO_MODE_ENABLED) {
    res.status(403).json({ error: 'Demo mode is disabled' });
    return;
  }

  // Verify the ALTCHA proof-of-work payload submitted by the client.
  // Skipped when ALTCHA_HMAC_KEY is not explicitly set (local dev / test).
  {
    const { altcha_payload } = req.body as { altcha_payload?: string };
    const captcha = await verifyCaptchaPayload(altcha_payload);
    if (!captcha.ok) {
      res.status(captcha.status).json({ error: captcha.error });
      return;
    }
  }

  // Hard cap — prevent disk exhaustion when many demo sessions are live.
  const { count } = registryStmts.countDemoUsers.get() as { count: number };
  if (count >= MAX_DEMO_USERS) {
    res.status(503).json({ error: 'Demo capacity reached, please try again later' });
    return;
  }

  const userId      = randomUUID();
  const workspaceId = randomUUID();
  const email       = `demo-${userId}@demo.local`;
  const now         = Date.now();
  const expiresAt   = now + DEMO_EXPIRY_HOURS * 60 * 60 * 1000;

  registryStmts.createDemoUser.run({
    id: userId,
    email,
    properties: JSON.stringify({ name: 'Demo User' }),
    created_at: now,
    demo_expires_at: expiresAt,
  });
  trackEvent('user-created', { type: 'demo' });

  const userDb = getUserDb(userId);
  seedDemoWorkspace(userDb, workspaceId);

  const token = jwt.sign(
    { sub: userId, email, is_demo: true },
    JWT_SECRET,
    { expiresIn: `${DEMO_EXPIRY_HOURS}h` },
  );

  // Session-scoped cookie — no maxAge so it disappears when the browser closes.
  res.cookie(SESSION_COOKIE, token, COOKIE_BASE);

  res.status(201).json({
    user: {
      id: userId,
      email,
      properties: { name: 'Demo User' },
      created_at: now,
      public_key: null,
    },
    workspace_keys: [],
    is_demo: true,
    demo_expires_at: expiresAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/demo/end-session
//
// Called by the client when the browser session ends (tab/window close via
// sendBeacon, or explicit logout) to immediately purge the ephemeral demo
// account — provided the user has NOT activated a free-trial link.
//
// If the user has a freetrial_token their data must survive for the full
// trial period, so the request is silently ignored (204 no-op).
// ---------------------------------------------------------------------------

demoRouter.post('/end-session', requireAuth, (req: Request, res: Response) => {
  if (!req.isDemo) {
    res.sendStatus(204);
    return;
  }

  const row = registryStmts.getUserById.get(req.userId) as UserRow | undefined;
  if (!row) {
    res.sendStatus(204);
    return;
  }

  // Free-trial users want their data to survive — don't purge.
  if (row.freetrial_token) {
    res.sendStatus(204);
    return;
  }

  // Immediate purge — same logic as the hourly cleanup.
  registryStmts.deleteAllWorkspaceKeysForUser.run(req.userId);
  registryStmts.deleteUser.run(req.userId);
  closeUserDb(req.userId);
  const dbPath = path.join(DATA_DIR, 'users', `${req.userId}.db`);
  try { fs.unlinkSync(dbPath); } catch { /* already removed */ }
  try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* ignore */ }
  try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* ignore */ }
  const uploadsDir = path.join(DATA_DIR, 'uploads', req.userId);
  try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`[demo] purged demo account ${req.userId} on session end`);
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Cleanup helpers — called by scheduleDemoCleanup() in index.ts
// ---------------------------------------------------------------------------

export function runDemoCleanup(): void {
  const expired = registryStmts.listExpiredDemoUsers.all(Date.now()) as { id: string }[];
  for (const { id } of expired) {
    registryStmts.deleteAllWorkspaceKeysForUser.run(id);
    registryStmts.deleteUser.run(id);
    closeUserDb(id);
    const dbPath = path.join(DATA_DIR, 'users', `${id}.db`);
    try { fs.unlinkSync(dbPath); } catch { /* already removed */ }
    try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* ignore */ }
    const uploadsDir = path.join(DATA_DIR, 'uploads', id);
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (expired.length > 0) {
    console.log(`[demo] purged ${expired.length} expired demo account(s)`);
  }
}

export function scheduleDemoCleanup(): void {
  runDemoCleanup();
  setInterval(runDemoCleanup, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// POST /api/demo/freetrial
//
// Activates a free-trial extension for the current demo session.
// Requires an active demo JWT (is_demo: true). Idempotent: calling again
// re-extends the expiry and returns the same token.
// ---------------------------------------------------------------------------

demoRouter.post('/freetrial', requireAuth, (req: Request, res: Response) => {
  if (!req.isDemo) {
    res.status(403).json({ error: 'Free trial is only available for demo accounts' });
    return;
  }

  const row = registryStmts.getUserById.get(req.userId) as UserRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Demo account not found' });
    return;
  }

  const now        = Date.now();
  const expiresAt  = now + DEMO_FREETRIAL_DAYS * 24 * 60 * 60 * 1000;
  // Reuse existing token for idempotency; generate one if this is the first call.
  const token      = row.freetrial_token ?? randomBytes(32).toString('hex');

  registryStmts.setFreeTrialToken.run({ token, expires_at: expiresAt, id: req.userId });
  trackEvent('user-type-changed', { from: getUserType(row), to: 'trial' });

  res.json({ freetrial_token: token, freetrial_expires_at: expiresAt });
});

// ---------------------------------------------------------------------------
// GET /api/demo/freetrial/:token
//
// Public re-entry endpoint. Validates the token, re-issues the session cookie,
// and returns a DemoProvisionResponse so the client can restore all atoms.
// ---------------------------------------------------------------------------

demoRouter.get('/freetrial/:token', demoLimiter, (req: Request, res: Response) => {
  if (!DEMO_MODE_ENABLED) {
    res.status(403).json({ error: 'Demo mode is disabled' });
    return;
  }

  const { token } = req.params;
  const row = registryStmts.getUserByFreeTrialToken.get(token) as UserRow | undefined;

  if (!row || !row.demo_expires_at || row.demo_expires_at < Date.now()) {
    res.status(404).json({ error: 'Free trial link is invalid or has expired' });
    return;
  }

  const remainingMs    = row.demo_expires_at - Date.now();
  const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));

  const jwtToken = jwt.sign(
    { sub: row.id, email: row.email, is_demo: true },
    JWT_SECRET,
    { expiresIn: `${remainingHours}h` },
  );

  res.cookie(SESSION_COOKIE, jwtToken, COOKIE_BASE);
  trackEvent('user-trial-redeemed');

  res.json({
    user: {
      id: row.id,
      email: row.email,
      properties: JSON.parse(row.properties) as Record<string, unknown>,
      created_at: row.created_at,
      public_key: null,
    },
    workspace_keys: [],
    is_demo: true,
    demo_expires_at: row.demo_expires_at,
  });
});
