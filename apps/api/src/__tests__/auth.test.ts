import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import { createHash, randomUUID, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

function hashPassword(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovernote-auth-test-'));
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

  it('registers an invited account and can issue a login token (legacy bcrypt path)', async () => {
    const email = 'alice@example.com';
    const password = 'CreateAccount123!';
    const passwordHash = hashPassword(password);

    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: passwordHash,
        name: 'Alice Example',
        invitationToken: 'invite-token-123',
        // No publicKey — simulates a legacy (pre-ZK) account for this test
      }),
    });

    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json() as {
      user: { id: string; email: string; properties: Record<string, unknown>; public_key: string | null };
      wrapped_content_key: string | null;
    };
    expect(registerBody.user.email).toBe(email);
    expect(registerBody.user.properties).toEqual({ name: 'Alice Example' });
    expect(registerBody.user.public_key).toBeNull();

    const { registryStmts, parseUserProperties } = await import('../db/registry');
    const userRow = registryStmts.getUserByEmail.get(email) as {
      status: string;
      public_key: string | null;
      wrapped_content_key: string | null;
      properties: string;
      password_hash: string;
    } | undefined;
    expect(userRow).toBeDefined();
    expect(userRow?.status).toBe('active');
    expect(parseUserProperties(userRow as never)).toEqual({ name: 'Alice Example' });
    expect(userRow?.password_hash).not.toBe(passwordHash);

    const invitationRow = registryStmts.getInvitationByToken.get('invite-token-123') as { accepted_at: number | null } | undefined;
    expect(invitationRow?.accepted_at).not.toBeNull();

    const loginRes = await fetch(`${baseUrl}/api/auth/login/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: passwordHash }),
    });

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { token: string; wrapped_content_key: string | null };
    expect(typeof loginBody.token).toBe('string');
    expect(loginBody.wrapped_content_key).toBeNull();
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
        password: hashPassword('passphrase'),
        name: 'Alice',
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        wrappedContentKey: 'wrapped-key-base64',
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
        password: hashPassword('passphrase'),
        name: 'Alice',
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        wrappedContentKey: 'wrapped-key-base64',
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
      wrapped_content_key: string | null;
    };
    expect(loginBody.user.email).toBe(email);
    expect(loginBody.user.public_key).toBe(keypair.publicKeyBase64);
    expect(loginBody.wrapped_content_key).toBe('wrapped-key-base64');
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
        password: hashPassword('passphrase'),
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        wrappedContentKey: 'wrapped-key-base64',
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
    const tokenBody = await tokenRes.json() as { token: string; wrapped_content_key: string | null };
    expect(typeof tokenBody.token).toBe('string');
    expect(tokenBody.wrapped_content_key).toBe('wrapped-key-base64');
  });

  it('ZK login — rejects a replayed nonce', async () => {
    const email = 'alice@example.com';
    const keypair = generateTestKeypair();

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: hashPassword('passphrase'),
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        wrappedContentKey: 'wrapped-key-base64',
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
        password: hashPassword('passphrase'),
        invitationToken: 'invite-token-123',
        publicKey: keypair.publicKeyBase64,
        wrappedContentKey: 'wrapped-key-base64',
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

  it('ZK login — rejects when account has no public key', async () => {
    const email = 'alice@example.com';

    // Register WITHOUT a public key (legacy account)
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: hashPassword('passphrase'),
        invitationToken: 'invite-token-123',
      }),
    });

    const challengeRes = await fetch(`${baseUrl}/api/auth/challenge?email=${encodeURIComponent(email)}`);
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Sign with any keypair — should be rejected because no public_key is stored
    const attacker = generateTestKeypair();
    const sig = attacker.sign(nonce);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nonce, signature: sig }),
    });
    expect(loginRes.status).toBe(401);
  });
});