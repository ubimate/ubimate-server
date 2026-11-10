// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * A server that does not bill (docs/CREEM.md §4.9): here the hosted module without CREEM_API_KEY,
 * in the ubimate-server extract the self-host module that replaces it. Both must answer the same,
 * since clients talk to either: `GET /api/billing` says billing is off, and nothing is refused.
 */
import express from 'express';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('a server that does not bill', () => {
  let tmpDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let token = '';
  let registry: typeof import('../db/registry');
  const USER = randomUUID();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-billing-off-test-'));
    Object.assign(process.env, { DATA_DIR: tmpDir, JWT_SECRET: 'test-jwt-secret', NODE_ENV: 'test' });
    delete process.env.CREEM_API_KEY;
    vi.resetModules();
    const jwt = (await import('jsonwebtoken')).default;
    token = jwt.sign({ sub: USER, email: 'user@example.com' }, 'test-jwt-secret', { expiresIn: '1h' });
    registry = await import('../db/registry');
    registry.registryStmts.createUser.run({
      id: USER, email: 'user@example.com', properties: '{}', created_at: Date.now(), status: 'active',
      public_key: null, wrapped_content_key: null, user_type: 'regular',
    });
    const billing = (await import('../billing')).default;
    const { documentsRouter } = await import('../routes/documents');
    const app = express();
    app.use('/api/billing/webhook', billing.billingWebhookRouter);
    app.use(express.json());
    app.use('/api/billing', billing.billingRouter);
    app.use('/api/documents', documentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of ['DATA_DIR', 'JWT_SECRET', 'NODE_ENV']) delete process.env[key];
    vi.resetModules();
  });

  const get = (p: string) => fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } });

  it('GET /api/billing says billing is off and the account is entitled', async () => {
    const res = await get('/api/billing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, plan: null, entitled: true, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, plansOnSale: [], grant: null });
  });

  it('refuses nothing and cancels nothing', async () => {
    const billing = (await import('../billing')).default;
    expect((await get('/api/documents')).status).toBe(200);
    expect(billing.isEntitled(USER)).toBe(true);
    expect(await billing.cancelSubscriptionsForDeletion(USER)).toEqual({ ok: true });
    expect(() => billing.describeBilling()).not.toThrow();
  });

  it('takes no webhook', async () => {
    const res = await fetch(`${baseUrl}/api/billing/webhook`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
