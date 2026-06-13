// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import { randomUUID, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Generate a raw Ed25519 keypair for test fixtures (no Argon2id; the tests
 * need to verify the server's signature-checking logic, not the client-side
 * key derivation).
 */
function generateTestKeypair() {
  const privKeyBytes = randomBytes(32);
  const pubKeyBytes = ed25519.getPublicKey(privKeyBytes);
  const publicKeyBase64 = Buffer.from(pubKeyBytes).toString('base64');
  return {
    publicKeyBase64,
    /** Sign the nonce hex string as UTF-8 bytes (matches server expectation). */
    sign: (nonce: string): string => {
      const sig = ed25519.sign(new TextEncoder().encode(nonce), privKeyBytes);
      return Buffer.from(sig).toString('base64');
    },
  };
}

describe('auth router', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express['application']['listen']> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-auth-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.REQUIRE_INVITATION = 'true';
    process.env.NODE_ENV = 'test';

    vi.resetModules();

    const [{ authRouter }, { registryStmts, closeRegistryDb }] = await Promise.all([
      import('../routes/auth'),
      import('../db/registry'),
    ]);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const invitationEmail = 'alice@example.com';
    registryStmts.insertInvitation.run({
      id: randomUUID(),
      token: 'invite-token-123',
      email: invitationEmail,
      created_at: Date.now(),
      expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
      sender_public_key: null,
      sender_signature: null,
    });

    // Store the close helper on the server object so afterEach can use it after the dynamic import.
    (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb = closeRegistryDb;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const closeRegistryDb = (server as typeof server & { closeRegistryDb?: () => void }).closeRegistryDb;
      closeRegistryDb?.();
      server = null;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.REQUIRE_INVITATION;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  it('registers an invited account and can issue a login token (ZK path)', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();
    const initialWorkspaceId = randomUUID();

    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: 'Alice Example',
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId,
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json() as {
      user: { id: string; email: string; properties: Record<string, unknown>; public_key: string | null; primary_workspace_id: string | null };
      workspace_keys: { workspace_id: string; wrapped_key: string }[];
    };
    expect(registerBody.user.email).toBe(email);
    expect(registerBody.user.properties).toEqual({ name: 'Alice Example' });
    expect(registerBody.user.public_key).toBe(keypair.publicKeyBase64);
    // The initial workspace is the protected "home" workspace.
    expect(registerBody.user.primary_workspace_id).toBe(initialWorkspaceId);

    const { registryStmts, parseUserProperties } = await import('../db/registry');
    const userRow = registryStmts.getUserByEmail.get(email) as {
      status: string;
      public_key: string | null;
      properties: string;
    } | undefined;
    expect(userRow).toBeDefined();
    expect(userRow?.status).toBe('active');
    expect(parseUserProperties(userRow as never)).toEqual({ name: 'Alice Example' });
    expect(userRow?.public_key).toBe(keypair.publicKeyBase64);
    const wsKeys = registryStmts.listWorkspaceKeysForUser.all(registerBody.user.id) as { wrapped_key: string }[];
    expect(wsKeys[0]?.wrapped_key).toBe('wrapped-key-base64');

    const invitationRow = registryStmts.getInvitationByToken.get('invite-token-123') as { accepted_at: number | null } | undefined;
    expect(invitationRow?.accepted_at).not.toBeNull();

    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };
    const signature = keypair.sign(nonce);

    const loginRes = await fetch(`${baseUrl}/api/auth/login/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature }),
    });

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { token: string; user: { primary_workspace_id: string | null }; workspace_keys: { workspace_id: string; wrapped_key: string }[] };
    expect(typeof loginBody.token).toBe('string');
    expect(loginBody.workspace_keys[0]?.wrapped_key).toBe('wrapped-key-base64');
    expect(loginBody.user.primary_workspace_id).toBe(initialWorkspaceId);
  });

  it('backfills primary_workspace_id to the oldest workspace key for legacy accounts', async () => {
    const email = 'legacy@example.com';
    const keypair = generateTestKeypair();
    const homeWorkspaceId = randomUUID();

    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: homeWorkspaceId,
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });
    expect(registerRes.status).toBe(201);
    const { user } = await registerRes.json() as { user: { id: string } };

    const { registryStmts, resolvePrimaryWorkspaceId } = await import('../db/registry');

    // Simulate a legacy account: clear the stored home id and add an OLDER
    // workspace key, so the backfill must select by granted_at, not insertion.
    registryStmts.setPrimaryWorkspaceId.run({ id: user.id, primary_workspace_id: null });
    const olderWorkspaceId = randomUUID();
    registryStmts.insertWorkspaceKey.run({
      workspace_id: olderWorkspaceId,
      user_id: user.id,
      wrapped_key: 'older-wrapped-key',
      granted_at: Date.now() - 60_000,
    });

    const resolved = resolvePrimaryWorkspaceId(user.id);
    expect(resolved).toBe(olderWorkspaceId);

    // The backfill is persisted, so a second call is stable.
    const persisted = registryStmts.getUserById.get(user.id) as { primary_workspace_id: string | null };
    expect(persisted.primary_workspace_id).toBe(olderWorkspaceId);
    expect(resolvePrimaryWorkspaceId(user.id)).toBe(olderWorkspaceId);
  });

  it('GET /challenge returns a nonce and reflects has_zk_keys correctly', async () => {
    const email = 'alice@example.com';

    // Before registration: has_zk_keys should be false (account doesn't exist yet)
    const res1 = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { nonce: string; expires_at: number; has_zk_keys: boolean };
    expect(typeof body1.nonce).toBe('string');
    expect(body1.nonce).toHaveLength(64); // 32 bytes as hex
    expect(body1.has_zk_keys).toBe(false);
    expect(body1.expires_at).toBeGreaterThan(Date.now());

    // Register a ZK account
    const keypair = generateTestKeypair();
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: 'Alice',
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    // After registration with publicKey: has_zk_keys should be true
    const res2 = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { nonce: string; has_zk_keys: boolean };
    expect(body2.has_zk_keys).toBe(true);
    expect(body2.nonce).toHaveLength(64);
  });

  it('ZK login — challenge-response sign-in sets a session cookie', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();

    // Register with ZK keys
    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: 'Alice',
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });
    expect(registerRes.status).toBe(201);

    // Get challenge
    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Sign and login
    const signature = keypair.sign(nonce);
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature }),
    });

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as {
      user: { email: string; public_key: string | null };
      workspace_keys: { workspace_id: string; wrapped_key: string }[];
    };
    expect(loginBody.user.email).toBe(email);
    expect(loginBody.user.public_key).toBe(keypair.publicKeyBase64);
    expect(loginBody.workspace_keys[0]?.wrapped_key).toBe('wrapped-key-base64');
    // HttpOnly cookie should be set
    expect(loginRes.headers.get('set-cookie')).toContain('nf_session');
  });

  it('ZK login/token — challenge-response returns a Bearer token', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };
    const signature = keypair.sign(nonce);

    const tokenRes = await fetch(`${baseUrl}/api/auth/login/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature }),
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as { token: string; workspace_keys: { workspace_id: string; wrapped_key: string }[] };
    expect(typeof tokenBody.token).toBe('string');
    expect(tokenBody.workspace_keys[0]?.wrapped_key).toBe('wrapped-key-base64');
  });

  it('ZK login — rejects a replayed nonce', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };
    const signature = keypair.sign(nonce);

    // First use — succeeds
    const first = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature }),
    });
    expect(first.status).toBe(200);

    // Replay with the same nonce — must be rejected
    const second = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature }),
    });
    expect(second.status).toBe(401);
  });

  it('ZK login — rejects a wrong signature', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Sign a *different* message (wrong nonce)
    const wrongSig = keypair.sign('wrong-nonce-entirely');

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature: wrongSig }),
    });
    expect(loginRes.status).toBe(401);
  });

  it('register rejects missing public key/wrapped key', async () => {
    const email = 'alice@example.com';

    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationToken: 'invite-token-123',
      }),
    });
    expect(res.status).toBe(400);
  });

  // ── ZK #5: expires_at enforcement & sender info in registration response ──

  it('rejects registration when invitation expires_at is in the past', async () => {
    const { registryStmts, closeRegistryDb: _ } = await import('../db/registry');
    registryStmts.insertInvitation.run({
      id: randomUUID(),
      token: 'expired-invite-token',
      email: 'expiredtest@example.com',
      created_at: Date.now() - 8 * 24 * 60 * 60 * 1000,
      expires_at: Date.now() - 1, // already expired
      sender_public_key: null,
      sender_signature: null,
    });

    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'expiredtest@example.com',
        name: 'Expired User',
        invitationToken: 'expired-invite-token',
        publicKey: generateTestKeypair().publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/elapsed/i);
  });

  it('includes sender_public_key and sender_signature in 201 response when invitation was signed', async () => {
    const privKey = randomBytes(32);
    const pubKey = ed25519.getPublicKey(privKey);
    const token = 'signed-invite-token-00' + '0'.repeat(43); // 64 hex chars
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const email = 'signedregtest@example.com';

    // Build canonical payload bytes (must match server logic)
    const payload = new TextEncoder().encode(
      `ubimate_invite:${token}:${email.toLowerCase().trim()}:${expiresAt}`,
    );
    const sig = ed25519.sign(payload, privKey);
    const sigBase64 = Buffer.from(sig).toString('base64');
    const pubKeyBase64 = Buffer.from(pubKey).toString('base64');

    const { registryStmts } = await import('../db/registry');
    registryStmts.insertInvitation.run({
      id: randomUUID(),
      token,
      email,
      created_at: Date.now(),
      expires_at: expiresAt,
      sender_public_key: pubKeyBase64,
      sender_signature: sigBase64,
    });

    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: 'Signed User',
        invitationToken: token,
        publicKey: generateTestKeypair().publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      user: { email: string };
      invitation?: { sender_public_key: string; sender_signature: string; expires_at: number };
    };
    expect(body.invitation).toBeDefined();
    expect(body.invitation?.sender_public_key).toBe(pubKeyBase64);
    expect(body.invitation?.sender_signature).toBe(sigBase64);
    expect(body.invitation?.expires_at).toBe(expiresAt);
  });

  it('omits invitation field in 201 response when invitation was unsigned', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        name: 'Alice',
        invitationToken: 'invite-token-123',
        publicKey: generateTestKeypair().publicKeyBase64,
        initialWorkspaceId: randomUUID(),
        initialWrappedWorkspaceKey: 'wrapped-key-base64',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { invitation?: unknown };
    expect(body.invitation).toBeUndefined();
  });

  it('reset-request is deprecated', async () => {
    const existingRes = await fetch(`${baseUrl}/api/auth/reset-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    expect(existingRes.status).toBe(410);

    const unknownRes = await fetch(`${baseUrl}/api/auth/reset-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(unknownRes.status).toBe(410);
  });

  it('reset-confirm is deprecated', async () => {
    const resetToken = 'f'.repeat(64);
    const confirmRes = await fetch(`${baseUrl}/api/auth/reset-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: 'irrelevant', confirm_wipe: true }),
    });
    expect(confirmRes.status).toBe(410);
  });
});