// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Tests for GET /api/unfurl — URL unfurl endpoint.
 *
 * Focuses on SSRF protection, including the redirect-chain fix: a URL that
 * passes the initial hostname check must not be allowed to redirect to a
 * private/internal IP address.
 *
 * NOTE: Test HTTP calls use Node's built-in `http.get` (not global `fetch`) so
 * that `vi.stubGlobal('fetch', ...)` only intercepts the route handler's
 * outbound fetch calls, not the test requests themselves.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import dns from 'dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Test HTTP helper ─────────────────────────────────────────────────────────

/** Make a GET request using Node's http module so global fetch stubs don't interfere. */
function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += String(chunk); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
      });
    }).on('error', reject);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('unfurl route — SSRF protection', () => {
  let server: import('net').Server | null = null;
  let base: string;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../middleware/auth', () => ({
      requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
    }));

    const { unfurlRouter } = await import('../routes/unfurl');
    const app = express();
    app.use('/api/unfurl', unfurlRouter);

    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    vi.resetModules();
  });

  it('blocks a direct private IPv4 address', async () => {
    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://10.0.0.1/page')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
  });

  it('blocks 192.168.x.x addresses', async () => {
    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://192.168.1.1/')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
  });

  it('blocks localhost', async () => {
    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://localhost/page')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
  });

  it('blocks hostnames that DNS-resolve to a private IP', async () => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['192.168.1.1']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://evil-internal.example/page')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
  });

  it('blocks a redirect chain that ends at a private IP (SSRF via open redirect)', async () => {
    // The initial URL passes the SSRF check — its hostname resolves to a public IP.
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['8.8.8.8']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    // The server returns a 301 redirect to a private IP address.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 301,
      ok: false,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'location' ? 'http://192.168.1.100/internal' : null,
      },
      body: null,
    }));

    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://public-host.example/page')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
  });
});
