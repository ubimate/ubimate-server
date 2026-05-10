import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function hashPassword(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
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

  it('registers an invited account and can issue a login token', async () => {
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
        publicKey: 'public-key-base64',
        wrappedContentKey: 'wrapped-content-key-base64',
      }),
    });

    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json() as {
      user: { id: string; email: string; properties: Record<string, unknown>; public_key: string | null };
      wrapped_content_key: string | null;
    };
    expect(registerBody.user.email).toBe(email);
    expect(registerBody.user.properties).toEqual({ name: 'Alice Example' });
    expect(registerBody.user.public_key).toBe('public-key-base64');
    expect(registerBody.wrapped_content_key).toBe('wrapped-content-key-base64');

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
    expect(userRow?.public_key).toBe('public-key-base64');
    expect(userRow?.wrapped_content_key).toBe('wrapped-content-key-base64');
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
    expect(loginBody.wrapped_content_key).toBe('wrapped-content-key-base64');
  });
});