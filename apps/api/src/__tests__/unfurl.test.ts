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

  // ── Bypasses from the 2026-11 security report ─────────────────────────────
  //
  // A real "internal" service on loopback, listening dual-stack so that every
  // spelling of "this machine" reaches it. Each case must be refused, and the
  // service must never see a request: a 400 that arrived after the fetch
  // would still be a leak of reachability.

  describe('addresses that name this machine', () => {
    let internal: http.Server;
    let port: number;
    let hits = 0;

    beforeEach(async () => {
      hits = 0;
      internal = http.createServer((_req, res) => {
        hits++;
        res.setHeader('content-type', 'text/html');
        res.end('<title>INTERNAL-SECRET-OK</title>');
      });
      internal.listen({ port: 0, host: '::', ipv6Only: false });
      await new Promise<void>((r) => internal.once('listening', r));
      port = (internal.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise<void>((r) => internal.close(() => r()));
    });

    const spellings = [
      'http://0.0.0.0:PORT/',
      'http://0.0.0.1:PORT/',
      'http://[::ffff:127.0.0.1]:PORT/',
      'http://[::ffff:7f00:1]:PORT/',
      'http://[0:0:0:0:0:ffff:127.0.0.1]:PORT/',
      'http://[::]:PORT/',
      'http://[::1]:PORT/',
      'http://127.1:PORT/',
      'http://2130706433:PORT/',
      'http://0x7f000001:PORT/',
      'http://LOCALHOST:PORT/',
      'http://localhost.:PORT/',
    ];

    it('lists the spellings it checks', () => {
      expect(spellings).toHaveLength(12);
    });

    it.each(spellings)('refuses %s without contacting it', async (template) => {
      const target = template.replace('PORT', String(port));
      const { status, body } = await httpGet(
        `${base}/api/unfurl?url=${encodeURIComponent(target)}`,
      );
      expect(body).not.toMatchObject({ title: 'INTERNAL-SECRET-OK' });
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'URL not allowed' });
      expect(hits).toBe(0);
    });

    /** Make `name` resolve to `answers`, leaving every other lookup alone. */
    function resolveAs(name: string, answers: { address: string; family: number }[]) {
      const real = dns.lookup;
      return vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: unknown, cb: unknown) => {
        if (host !== name) return (real as (...a: unknown[]) => void)(host, opts, cb);
        const callback = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
        const all = typeof opts === 'object' && opts !== null && (opts as dns.LookupOptions).all;
        process.nextTick(() =>
          all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family),
        );
      }) as typeof dns.lookup);
    }

    // The name passes the check made before fetching (it is not an IP and not
    // a local-only name), so only the connect-time lookup can refuse it. That
    // is also the DNS-rebinding case: the address checked is the one used.
    it('refuses a name that resolves to loopback when connecting', async () => {
      const lookup = resolveAs('evil-internal.example', [{ address: '127.0.0.1', family: 4 }]);
      const { status, body } = await httpGet(
        `${base}/api/unfurl?url=${encodeURIComponent(`http://evil-internal.example:${port}/`)}`,
      );
      expect(lookup.mock.calls.some(([h]) => h === 'evil-internal.example')).toBe(true);
      expect(body).not.toMatchObject({ title: 'INTERNAL-SECRET-OK' });
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'URL not allowed' });
      expect(hits).toBe(0);
    });

    it('refuses a name with one public and one loopback answer', async () => {
      resolveAs('mixed.example', [
        { address: '93.184.215.14', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
      ]);
      const { status } = await httpGet(
        `${base}/api/unfurl?url=${encodeURIComponent(`http://mixed.example:${port}/`)}`,
      );
      expect(status).toBe(400);
      expect(hits).toBe(0);
    });

    it('the internal service is reachable when asked directly (control)', async () => {
      const { body } = await httpGet(`http://127.0.0.1:${port}/`);
      expect(body).toContain('INTERNAL-SECRET-OK');
      expect(hits).toBe(1);
    });
  });
});

// The first hop has to be public for a redirect to be the attack, and a test
// cannot reach a public host, so this one fakes undici's fetch. The guard
// itself (lib/publicAddress) is real.
describe('unfurl route — redirects', () => {
  let server: import('net').Server | null = null;
  let base: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
    }));
    vi.doMock('undici', async (importOriginal) => ({
      ...(await importOriginal<typeof import('undici')>()),
      fetch: fetchMock,
    }));
    const { unfurlRouter } = await import('../routes/unfurl');
    const app = express();
    app.use('/api/unfurl', unfurlRouter);
    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.doUnmock('undici');
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    vi.resetModules();
  });

  const redirectTargets = [
    'http://192.168.1.100/internal',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://0.0.0.0:8080/',
  ];

  it.each(redirectTargets)('refuses a redirect to %s', async (location) => {
    fetchMock.mockResolvedValue({
      status: 301,
      ok: false,
      headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
      body: null,
    });

    const { status, body } = await httpGet(
      `${base}/api/unfurl?url=${encodeURIComponent('http://public-host.example/page')}`,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'URL not allowed' });
    // Only the first hop was fetched, and through the guarded dispatcher.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('dispatcher');
  });
});

