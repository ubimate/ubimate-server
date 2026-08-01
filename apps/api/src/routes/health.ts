import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pingRegistryDb } from '../db/registry';

// Resolved the same way as registry.ts / index.ts so DATA_DIR=/data (the
// CapRover persistent volume) is honoured here too.
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');

export const healthRouter = Router();

/**
 * Liveness — this is what the container HEALTHCHECK polls (Dockerfile, `api`
 * target). It deliberately does no I/O.
 *
 * A container restart can only fix one thing: a process whose event loop has
 * stopped turning. It cannot fix a full disk or a corrupt database. So this
 * probe answers exactly that question and nothing more — anything heavier here
 * would turn a dependency outage into a restart loop that destroys the SQLite
 * WAL without ever recovering. Dependency health lives on /ready below, where
 * it pages a human instead.
 */
healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

interface CheckResult {
  ok: boolean;
  /** Stable machine-readable code. Never the raw error — this route is public. */
  error?: string;
}

function checkRegistryDb(): CheckResult {
  try {
    pingRegistryDb();
    return { ok: true };
  } catch (err) {
    console.error('[health] registry db check failed:', err);
    return { ok: false, error: 'query_failed' };
  }
}

function checkDataDirWritable(): CheckResult {
  // SELECT 1 is read-only and stays green on a full or read-only volume, which
  // is precisely how SQLite deployments die in practice. Probe with a real
  // write so ENOSPC/EROFS actually surfaces.
  const probe = path.join(DATA_DIR, '.health-probe');
  try {
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    console.error('[health] data dir write check failed:', err);
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * Readiness — for external uptime monitoring. Exercises the dependencies the
 * API genuinely cannot serve without and returns 503 when any is down, so a
 * silent dependency failure raises an alert instead of a green dashboard.
 *
 * Unauthenticated so monitors can reach it, therefore it discloses only
 * per-check booleans and fixed error codes; full detail goes to the log.
 */
healthRouter.get('/ready', (_req: Request, res: Response) => {
  const checks = {
    db: checkRegistryDb(),
    disk: checkDataDirWritable(),
  };
  const ok = Object.values(checks).every((c) => c.ok);

  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    timestamp: Date.now(),
    checks,
  });
});
