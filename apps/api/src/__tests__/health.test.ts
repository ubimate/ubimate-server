// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import express from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CheckBody {
  ok: boolean;
  error?: string;
}
interface HealthBody {
  status: string;
  timestamp: number;
  checks: Record<'db' | 'disk', CheckBody>;
}

/** fetch().json() is typed `unknown` under this tsconfig; narrow it once here. */
async function readBody(res: globalThis.Response): Promise<HealthBody> {
  return (await res.json()) as HealthBody;
}

describe('health router', () => {
  let tmpDir: string;
  let server: ReturnType<express.Application['listen']> | null = null;
  let baseUrl = '';
  let closeRegistryDb: () => void;
  let registryModule: typeof import('../db/registry');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-health-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NODE_ENV = 'test';

    vi.resetModules();

    const [{ healthRouter }, registry] = await Promise.all([
      import('../routes/health'),
      import('../db/registry'),
    ]);
    registryModule = registry;
    closeRegistryDb = registry.closeRegistryDb;

    const app = express();
    app.use('/api/health', healthRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    closeRegistryDb?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/health (liveness)', () => {
    it('returns 200 with the documented shape', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      const body = await readBody(res);
      expect(body.status).toBe('ok');
      expect(typeof body.timestamp).toBe('number');
    });

    // The container HEALTHCHECK polls this route. If it started failing on
    // dependency outages, Swarm would restart-loop a container that a restart
    // cannot fix — so liveness must stay green even with the DB shut down.
    it('stays green when the registry DB is unavailable', async () => {
      registryModule.closeRegistryDb();

      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      expect((await readBody(res)).status).toBe('ok');
    });
  });

  describe('GET /api/health/ready (readiness)', () => {
    it('returns 200 and all checks green when healthy', async () => {
      const res = await fetch(`${baseUrl}/api/health/ready`);
      expect(res.status).toBe(200);

      const body = await readBody(res);
      expect(body.status).toBe('ok');
      expect(body.checks.db.ok).toBe(true);
      expect(body.checks.disk.ok).toBe(true);
    });

    it('returns 503 and flags db when the registry DB is unusable', async () => {
      registryModule.closeRegistryDb();

      const res = await fetch(`${baseUrl}/api/health/ready`);
      expect(res.status).toBe(503);

      const body = await readBody(res);
      expect(body.status).toBe('degraded');
      expect(body.checks.db).toEqual({ ok: false, error: 'query_failed' });
      // Failure is attributed to the check that actually broke.
      expect(body.checks.disk.ok).toBe(true);
    });

    it('returns 503 and flags disk when DATA_DIR is not writable', async () => {
      // The read-only-volume / ENOSPC case a `SELECT 1` probe would miss.
      fs.chmodSync(tmpDir, 0o500);
      try {
        const res = await fetch(`${baseUrl}/api/health/ready`);
        expect(res.status).toBe(503);

        const body = await readBody(res);
        expect(body.status).toBe('degraded');
        expect(body.checks.disk).toEqual({ ok: false, error: 'write_failed' });
      } finally {
        fs.chmodSync(tmpDir, 0o700);
      }
    });

    it('leaves no probe file behind', async () => {
      await fetch(`${baseUrl}/api/health/ready`);
      expect(fs.existsSync(path.join(tmpDir, '.health-probe'))).toBe(false);
    });

    it('does not leak filesystem paths or raw errors', async () => {
      registryModule.closeRegistryDb();
      fs.chmodSync(tmpDir, 0o500);
      try {
        const raw = await (await fetch(`${baseUrl}/api/health/ready`)).text();
        expect(raw).not.toContain(tmpDir);
        expect(raw).not.toContain('SQLITE');
      } finally {
        fs.chmodSync(tmpDir, 0o700);
      }
    });
  });
});
