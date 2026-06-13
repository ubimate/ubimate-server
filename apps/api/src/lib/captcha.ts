/**
 * Shared ALTCHA proof-of-work captcha helpers.
 *
 * Used to protect public, unauthenticated endpoints (demo provisioning and
 * account registration) from automated abuse. ALTCHA is a self-hosted,
 * privacy-friendly proof-of-work scheme — no third-party widget, so it works
 * identically in a browser and inside a Tauri WebView (the client solves it
 * with `crypto.subtle`).
 *
 * Enforcement is opt-in: verification only runs when `ALTCHA_HMAC_KEY` is set
 * (production). In local dev / tests the key is unset, challenges are still
 * issued with an ephemeral key, and verification is skipped so flows work
 * without solving a PoW.
 */
import { randomBytes } from 'node:crypto';

// altcha-lib v1: use require() because moduleResolution:node can't resolve
// types via package exports conditions, and the deep path isn't in the
// exports map so Node rejects it at runtime. The './v1' subpath is exported
// and has CJS + ESM entries, so require() works in both tsx and compiled JS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createChallenge, verifySolution } = require('altcha-lib/v1') as {
  createChallenge(opts: { algorithm?: string; hmacKey: string; maxNumber?: number; expires?: Date }): Promise<AltchaChallenge>;
  verifySolution(payload: string, hmacKey: string, checkExpires?: boolean): Promise<boolean>;
};

export interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export type CaptchaResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Ephemeral fallback key used only to *issue* challenges when no
 * ALTCHA_HMAC_KEY is configured (dev/test). Never used for verification —
 * verification is skipped entirely when the env key is absent.
 */
const FALLBACK_HMAC_KEY = randomBytes(32).toString('hex');

/** PoW difficulty: max random number the client must search up to. ~1-3 s CPU. */
const ALTCHA_MAX_NUMBER = Number(process.env.ALTCHA_MAX_NUMBER) || 100_000;

/** The HMAC key in effect right now (read live so tests can toggle it). */
function activeKey(): string {
  return process.env.ALTCHA_HMAC_KEY ?? FALLBACK_HMAC_KEY;
}

/** True when captcha solutions are required (ALTCHA_HMAC_KEY configured). */
export function isCaptchaEnforced(): boolean {
  return Boolean(process.env.ALTCHA_HMAC_KEY);
}

/** Issue a fresh PoW challenge (valid for 10 minutes). */
export function issueCaptchaChallenge(): Promise<AltchaChallenge> {
  return createChallenge({
    hmacKey: activeKey(),
    maxNumber: ALTCHA_MAX_NUMBER,
    expires: new Date(Date.now() + 10 * 60 * 1000),
  });
}

/**
 * Verify a submitted ALTCHA payload. Returns `{ ok: true }` when enforcement
 * is disabled (no env key) so callers can treat the result uniformly.
 */
export async function verifyCaptchaPayload(payload: string | undefined): Promise<CaptchaResult> {
  if (!isCaptchaEnforced()) return { ok: true };
  if (!payload) return { ok: false, status: 400, error: 'CAPTCHA solution required' };
  let valid = false;
  try {
    valid = await verifySolution(payload, activeKey(), true);
  } catch {
    // Malformed payloads make verifySolution throw — treat as invalid.
    valid = false;
  }
  if (!valid) return { ok: false, status: 403, error: 'CAPTCHA solution invalid or expired' };
  return { ok: true };
}
