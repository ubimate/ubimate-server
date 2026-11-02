// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * lib/objectStore — the configuration, and what the real presigner signs. No network: presigning is
 * a local computation. What a real bucket does with these URLs is checked by objectStore.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertObjectStorageConfigured, createS3ObjectStore, loadS3Config } from '../lib/objectStore';

const ENV = { S3_ENDPOINT: 'https://eu2.example.test', S3_BUCKET: 'ubimate', S3_ACCESS_KEY: 'AK', S3_SECRET_KEY: 'SK' };

describe('loadS3Config', () => {
  it('is null unless the endpoint, bucket and both keys are set', () => {
    expect(loadS3Config({})).toBeNull();
    for (const missing of Object.keys(ENV)) {
      const env: NodeJS.ProcessEnv = { ...ENV };
      delete env[missing];
      expect(loadS3Config(env), missing).toBeNull();
    }
    expect(loadS3Config({ ...ENV, S3_BUCKET: '' })).toBeNull();
  });

  it('reads the region, with the documented default', () => {
    expect(loadS3Config(ENV)).toMatchObject({ endpoint: ENV.S3_ENDPOINT, bucket: 'ubimate', region: 'eu-central-1' });
    expect(loadS3Config({ ...ENV, S3_REGION: 'eu2' })?.region).toBe('eu2');
  });

  it('keeps the credential that may delete apart when it is given, and says when it is not', () => {
    expect(loadS3Config(ENV)).toMatchObject({ cleanupAccessKey: 'AK', cleanupSecretAccessKey: 'SK', cleanupIsMain: true });
    expect(loadS3Config({ ...ENV, S3_CLEANUP_ACCESS_KEY: 'CK', S3_CLEANUP_SECRET_KEY: 'CS' }))
      .toMatchObject({ cleanupAccessKey: 'CK', cleanupSecretAccessKey: 'CS', cleanupIsMain: false });
    // Half a pair is not a credential.
    expect(loadS3Config({ ...ENV, S3_CLEANUP_ACCESS_KEY: 'CK' })).toMatchObject({ cleanupAccessKey: 'AK', cleanupIsMain: true });
  });
});

describe('the presigned URLs of the real S3 store', () => {
  const store = createS3ObjectStore(loadS3Config(ENV)!);
  const params = (url: string) => new URL(url).searchParams;

  it('PUT: addressed by path, with the length and the type signed, and the expiry asked for', async () => {
    const { url, headers } = await store.presignPut('a/att-1', 1234, 'application/octet-stream', 900);
    const u = new URL(url);
    expect(u.origin).toBe('https://eu2.example.test');
    expect(u.pathname).toBe('/ubimate/a/att-1');
    const signed = (params(url).get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toContain('content-length');
    expect(signed).toContain('content-type');
    expect(params(url).get('X-Amz-Expires')).toBe('900');
    expect(params(url).get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Length': '1234' });
  });

  it('PUT: asks the client for nothing a browser\'s plain PUT does not send (no checksum header or parameter)', async () => {
    const { url } = await store.presignPut('a/att-1', 10, 'application/octet-stream', 60);
    const keys = [...params(url).keys()].map((k) => k.toLowerCase());
    expect(keys.filter((k) => k.includes('checksum'))).toEqual([]);
    expect((params(url).get('X-Amz-SignedHeaders') ?? '').split(';').filter((h) => h.startsWith('x-amz-'))).toEqual([]);
  });

  it('PUT: a different length is a different signature', async () => {
    const a = params((await store.presignPut('a/x', 10, 'application/octet-stream', 60)).url).get('X-Amz-Signature');
    const b = params((await store.presignPut('a/x', 11, 'application/octet-stream', 60)).url).get('X-Amz-Signature');
    expect(a).not.toBe(b);
  });

  it('GET: signs the object and the expiry, and no body headers', async () => {
    const url = await store.presignGet('a/att-1', 300);
    expect(new URL(url).pathname).toBe('/ubimate/a/att-1');
    expect(params(url).get('X-Amz-Expires')).toBe('300');
    expect(params(url).get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('never puts the secret key in a URL', async () => {
    const { url } = await store.presignPut('a/att-1', 10, 'application/octet-stream', 60);
    expect(url).not.toContain('SK');
    expect(await store.presignGet('a/att-1', 60)).not.toMatch(/SecretKey|=SK(&|$)/);
  });
});

describe('assertObjectStorageConfigured', () => {
  it('lets a production run through with a complete configuration', () => {
    expect(() => assertObjectStorageConfigured({ ...ENV, NODE_ENV: 'production' })).not.toThrow();
  });

  it('refuses a production run without one, and names what is missing', () => {
    expect(() => assertObjectStorageConfigured({ NODE_ENV: 'production' })).toThrow(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY/);
  });

  it('names only the variables that are missing from a partial configuration', () => {
    const { S3_SECRET_KEY: _s, S3_BUCKET: _b, ...partial } = ENV;
    let message = '';
    try { assertObjectStorageConfigured({ ...partial, NODE_ENV: 'production' }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('S3_BUCKET, S3_SECRET_KEY');
    expect(message).not.toContain('S3_ENDPOINT');
  });

  it.each(['development', 'test', undefined])('does not ask for a bucket when NODE_ENV is %s: the disk is the dev fallback', (env) => {
    expect(() => assertObjectStorageConfigured({ NODE_ENV: env })).not.toThrow();
  });

  it('stops the server at startup: production without a bucket exits 1 with the message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-startup-'));
    try {
      const tsx = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATA_DIR: dir, API_PORT: '0', JWT_SECRET: 'x' };
      for (const k of Object.keys(env)) if (k.startsWith('S3_')) delete env[k];
      const run = spawnSync(tsx, ['src/index.ts'], { cwd: path.join(__dirname, '..', '..'), env, encoding: 'utf8', timeout: 30_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Object storage is not configured');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('S3_PUBLIC_ENDPOINT', () => {
  it('defaults to the endpoint', () => {
    expect(loadS3Config(ENV)!.publicEndpoint).toBe(ENV.S3_ENDPOINT);
  });

  it('is the host signed URLs name, where browsers reach the bucket, when it differs from the API\'s', async () => {
    const config = loadS3Config({ ...ENV, S3_ENDPOINT: 'http://seaweedfs:8333', S3_PUBLIC_ENDPOINT: 'https://files.example.test' })!;
    const store = createS3ObjectStore(config);
    const put = await store.presignPut('a/x', 10, 'application/octet-stream', 300);
    expect(new URL(put.url).origin).toBe('https://files.example.test');
    expect(new URL(await store.presignGet('a/x', 300)).origin).toBe('https://files.example.test');
  });
});
