/**
 * Integration tests for POST /api/admin/invitations — ZK #5 signature paths.
 *
 * Tests cover:
 *   - Unsigned invitation (original behaviour, backward-compatible)
 *   - Signed invitation with a valid Ed25519 signature → stored correctly
 *   - Signed invitation with a tampered signature → rejected 400
 *   - Signed invitation with a mismatched public key → rejected 400
 *   - Malformed base64 in sender fields → rejected 400
 *   - Custom token and expires_at accepted when unsigned
 *   - Invalid token format rejected
 */

import express from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

// ---------------------------------------------------------------------------
// Crypto helpers (same approach as auth.test.ts — avoid Argon2id in tests)
// ---------------------------------------------------------------------------

function generateKeypair() {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

function signPayload(token: string, email: string, expiresAt: number, privateKey: Uint8Array): string {
  const payload = new TextEncoder().encode(
    `ubimate_invite:${token}:${email.toLowerCase().trim()}:${expiresAt}`,
  );
  const sig = ed25519.sign(payload, privateKey);
  return Buffer.from(sig).toString('base64');
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('admin router — POST /api/admin/invitations (ZK #5)', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express['application']['listen']> | null = null;
  let baseUrl = '';
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-admin-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.ADMIN_USERNAME = 'testadmin';
    process.env.ADMIN_PASSWORD = 'AdminPass123!';
    process.env.ADMIN_EMAIL = 'admin@ubimate.test';
    process.env.NODE_ENV = 'test';
    // Disable email sending to avoid SMTP errors in tests
    delete process.env.SMTP_HOST;

    vi.resetModules();

    const [{ adminRouter }, { closeRegistryDb }] = await Promise.all([
      import('../routes/admin'),
      import('../db/registry'),
    ]);

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Log in as admin to get a bearer token for subsequent requests.
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'AdminPass123!' }),
    });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json() as { token: string };
    adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb = closeRegistryDb;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const closeRegistryDb = (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb;
      closeRegistryDb?.();
      server = null;
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    ['DATA_DIR', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_EMAIL', 'NODE_ENV'].forEach(
      (k) => delete process.env[k],
    );
    vi.resetModules();
  });

  // ── Backward-compatible unsigned flow ──────────────────────────────────────

  it('creates an invitation without a signature (unsigned, backward-compat)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: 'bob@example.com' }),
    });

    // May return 201 (email not configured) or 502 (SMTP configured but failed);
    // either way the invitation must be created.
    expect([201, 502]).toContain(res.status);
    const body = await res.json() as {
      id: string;
      token: string;
      email: string;
      status: string;
    };
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBe(64); // 32 bytes hex
    expect(body.email).toBe('bob@example.com');
    expect(body.status).toBe('pending');
  });

  // ── Signed invitation — happy path ────────────────────────────────────────

  it('accepts a validly signed invitation and stores signature fields', async () => {
    const kp = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const email = 'carol@example.com';
    const signature = signPayload(token, email, expiresAt, kp.privateKey);

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email,
        token,
        expires_at: expiresAt,
        sender_signature: signature,
        sender_public_key: toBase64(kp.publicKey),
      }),
    });

    expect([201, 502]).toContain(res.status);
    const body = await res.json() as { token: string; email: string; status: string };
    expect(body.token).toBe(token);
    expect(body.email).toBe(email);
    expect(body.status).toBe('pending');
  });

  it('uses the client-supplied token verbatim when provided', async () => {
    const customToken = 'c'.repeat(64);
    const expiresAt = Date.now() + 86_400_000;
    const kp = generateKeypair();
    const sig = signPayload(customToken, 'dave@example.com', expiresAt, kp.privateKey);

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'dave@example.com',
        token: customToken,
        expires_at: expiresAt,
        sender_signature: sig,
        sender_public_key: toBase64(kp.publicKey),
      }),
    });

    expect([201, 502]).toContain(res.status);
    const body = await res.json() as { token: string };
    expect(body.token).toBe(customToken);
  });

  it('normalises the email to lowercase when verifying the signature', async () => {
    const kp = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 86_400_000;
    // Sign against lowercase — send mixed-case in the request body
    const sig = signPayload(token, 'eve@example.com', expiresAt, kp.privateKey);

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'Eve@Example.COM',
        token,
        expires_at: expiresAt,
        sender_signature: sig,
        sender_public_key: toBase64(kp.publicKey),
      }),
    });

    expect([201, 502]).toContain(res.status);
  });

  // ── Signed invitation — rejection paths ───────────────────────────────────

  it('rejects a signed invitation when the signature is invalid (tampered payload)', async () => {
    const kp = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 86_400_000;
    // Sign correct payload, then change the token in the request body
    const sig = signPayload(token, 'frank@example.com', expiresAt, kp.privateKey);
    const tamperedToken = randomBytes(32).toString('hex'); // different token

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'frank@example.com',
        token: tamperedToken,
        expires_at: expiresAt,
        sender_signature: sig,
        sender_public_key: toBase64(kp.publicKey),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid sender_signature');
  });

  it('rejects when signature is for a different public key', async () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 86_400_000;
    const sig = signPayload(token, 'grace@example.com', expiresAt, kp1.privateKey);

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'grace@example.com',
        token,
        expires_at: expiresAt,
        sender_signature: sig,
        sender_public_key: toBase64(kp2.publicKey), // wrong public key
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid sender_signature');
  });

  it('rejects when only sender_signature is provided without sender_public_key', async () => {
    const kp = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 86_400_000;
    const sig = signPayload(token, 'henry@example.com', expiresAt, kp.privateKey);

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'henry@example.com',
        token,
        expires_at: expiresAt,
        sender_signature: sig,
        // sender_public_key intentionally omitted
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/both be provided/);
  });

  it('rejects malformed base64 in sender_signature', async () => {
    const kp = generateKeypair();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 86_400_000;

    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'ivan@example.com',
        token,
        expires_at: expiresAt,
        sender_signature: '!!!not-base64!!!',
        sender_public_key: toBase64(kp.publicKey),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Malformed/);
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it('rejects a token that is not 64 hex chars', async () => {
    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: 'judy@example.com', token: 'tooshort' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/64-character hex/);
  });

  it('rejects a non-numeric expires_at', async () => {
    const res = await fetch(`${baseUrl}/api/admin/invitations`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: 'kate@example.com', expires_at: 'not-a-number' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/expires_at/);
  });
});
