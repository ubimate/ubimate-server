/**
 * The S3 stand-in for the e2e suites (docs/ATTACHMENT-ENCRYPTION.md 14.1). Attachments go to a bucket in every
 * environment that matters, so the suites run against one: `startE2eS3` starts the in-process server of
 * src/__tests__/helpers/s3TestServer.ts as a child process and records where it is in a state file, because the API
 * is (re)started from other processes than the one that started this (a spec worker pausing and resuming it).
 *
 *  - `S3_ENDPOINT` already set: an S3 server the caller runs (Docker, `pnpm test:s3`); nothing is started, and the
 *    `S3_*` variables in the environment reach the API as they are.
 *  - `UBIMATE_E2E_STORAGE=local`: no bucket, the API keeps attachments on its disk (the dev fallback).
 *  - Otherwise: the in-process server.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';

const API_DIR = path.resolve(import.meta.dirname, '..');

interface State { pid: number; endpoint: string; bucket: string; region: string; accessKey: string; secretAccessKey: string; cleanupAccessKey: string; cleanupSecretAccessKey: string }

function readState(stateFile: string): State | null {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State; } catch { return null; }
}

/** True when this run's API keeps attachments in a bucket. */
export function e2eUsesS3(stateFile: string): boolean {
  if (process.env.S3_ENDPOINT) return true;
  return process.env.UBIMATE_E2E_STORAGE !== 'local' && readState(stateFile) !== null;
}

/** The `S3_*` variables to give the API process: the server `startE2eS3` started, else none (the environment's own pass through). */
export function e2eS3Env(stateFile: string): Record<string, string> {
  if (process.env.S3_ENDPOINT) return {};
  const s = readState(stateFile);
  if (!s) return {};
  return {
    S3_ENDPOINT: s.endpoint, S3_BUCKET: s.bucket, S3_REGION: s.region, S3_ACCESS_KEY: s.accessKey, S3_SECRET_KEY: s.secretAccessKey,
    S3_CLEANUP_ACCESS_KEY: s.cleanupAccessKey, S3_CLEANUP_SECRET_KEY: s.cleanupSecretAccessKey,
  };
}

/** Stops the server recorded in `stateFile`, if it is still ours (a pid can be reused after a crash). */
export function stopE2eS3(stateFile: string): void {
  const s = readState(stateFile);
  if (s) {
    const cmd = spawnSync('ps', ['-p', String(s.pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
    if (cmd.includes('s3-test-server')) { try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  try { fs.rmSync(stateFile); } catch { /* none */ }
}

export async function startE2eS3(stateFile: string): Promise<void> {
  stopE2eS3(stateFile);
  if (process.env.S3_ENDPOINT || process.env.UBIMATE_E2E_STORAGE === 'local') return;
  const isWin = process.platform === 'win32';
  const tsx = path.join(API_DIR, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
  const child = spawn(tsx, ['scripts/s3-test-server.ts'], { cwd: API_DIR, shell: isWin, stdio: ['ignore', 'pipe', 'inherit'] });
  const first = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('[e2e-s3] the S3 test server did not start within 20 s')), 20_000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`[e2e-s3] the S3 test server exited with ${code}`)); });
    createInterface({ input: child.stdout! }).once('line', (line) => { clearTimeout(timer); resolve(line); });
  });
  const info = JSON.parse(first) as Omit<State, 'pid'>;
  fs.writeFileSync(stateFile, JSON.stringify({ ...info, pid: child.pid }), 'utf8');
  child.stdout?.destroy();
  child.removeAllListeners('exit');
  child.unref();
  console.log('[e2e-s3] S3 test server at', info.endpoint);
}
