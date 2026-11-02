// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * The real store (the AWS SDK's presigner and client) against a bucket: what docs/ATTACHMENT-ENCRYPTION.md 13.1 asked
 * and the design relies on. By default the bucket is the in-process S3 server of helpers/s3TestServer.ts. With
 * `S3_LIVE=1` and the S3_* variables (docs/OBJECT-STORAGE.md) it is that bucket instead, which must be one that may be
 * written to; the test writes and deletes objects under a `live-test-` prefix.
 *
 *   S3_LIVE=1 S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… pnpm --filter api test objectStore.live
 *
 * The same cases passing against the in-process server and a real one is what keeps the first honest.
 *
 * Or, against a throwaway S3 server in Docker: `pnpm --filter api test:s3` (scripts/test-s3.sh). That server ignores an
 * Authorization header beside a query signature where AWS and Contabo refuse it, so the script sets
 * S3_IGNORES_AUTH_WITH_SIGNATURE=1 to skip that one case (the client sends none either way).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3ObjectStore, loadS3Config, type S3Config } from '../lib/objectStore';
import { ensureTestBucket } from './helpers/s3Bucket';
import { startS3TestServer, type S3TestServer } from './helpers/s3TestServer';

const external = process.env.S3_LIVE === '1' ? loadS3Config() : null;

describe(external ? 'the S3 store against a real bucket' : 'the S3 store against the in-process S3 server', () => {
  let config: S3Config;
  let local: S3TestServer | null = null;
  let store: ReturnType<typeof createS3ObjectStore>;
  const prefix = `live-test-${Date.now()}/`;
  const made: string[] = [];
  const body = (n: number) => new Uint8Array(n).fill(7);
  const put = (url: string, headers: Record<string, string>, data: Uint8Array) => {
    // A browser sets Content-Length itself from the body; here fetch does the same.
    const { 'Content-Length': _l, ...rest } = headers;
    return fetch(url, { method: 'PUT', headers: rest, body: data as BodyInit });
  };

  beforeAll(async () => {
    if (external) {
      config = external;
    } else {
      local = await startS3TestServer({ bucket: 'b', credentials: { main: 'main-secret', cleanup: 'cleanup-secret' }, denyDelete: ['main'] });
      config = {
        endpoint: local.endpoint, publicEndpoint: local.endpoint, bucket: 'b', region: 'us-east-1', accessKey: 'main', secretAccessKey: 'main-secret',
        cleanupAccessKey: 'cleanup', cleanupSecretAccessKey: 'cleanup-secret', cleanupIsMain: false,
      };
    }
    store = createS3ObjectStore(config);
    await ensureTestBucket(config);
  }, 60_000);

  afterAll(async () => {
    for (const key of made) await store.delete(key).catch(() => {});
    await local?.close();
  });

  it('takes a PUT of exactly the signed length and reports its size', async () => {
    const key = `${prefix}exact`; made.push(key);
    const { url, headers } = await store.presignPut(key, 1000, 'application/octet-stream', 300);
    expect((await put(url, headers, body(1000))).status).toBe(200);
    expect(await store.head(key)).toBe(1000);
  });

  it.each([['one byte more', 1001], ['one byte less', 999], ['ten times more', 10_000]])('refuses a PUT of %s than the signed length', async (_label, n) => {
    const key = `${prefix}wrong-${n}`; made.push(key);
    const { url, headers } = await store.presignPut(key, 1000, 'application/octet-stream', 300);
    const res = await put(url, headers, body(n));
    expect(res.status).toBe(403);
    expect(await store.head(key)).toBeNull();
  });

  it('refuses a PUT whose Content-Type is not the signed one', async () => {
    const key = `${prefix}type`; made.push(key);
    const { url } = await store.presignPut(key, 10, 'application/octet-stream', 300);
    expect((await put(url, { 'Content-Type': 'image/png' }, body(10))).status).toBe(403);
  });

  it.skipIf(process.env.S3_IGNORES_AUTH_WITH_SIGNATURE === '1')('refuses a PUT that also carries an Authorization header: why the client sends none', async () => {
    const key = `${prefix}auth`; made.push(key);
    const { url, headers } = await store.presignPut(key, 10, 'application/octet-stream', 300);
    const res = await put(url, { ...headers, Authorization: 'Bearer x' }, body(10));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await store.head(key)).toBeNull();
  });

  it('serves a signed GET to anyone holding the URL, and refuses a tampered one', async () => {
    const key = `${prefix}get`; made.push(key);
    const { url, headers } = await store.presignPut(key, 50, 'application/octet-stream', 300);
    await put(url, headers, body(50));
    const get = await store.presignGet(key, 300);
    const ok = await fetch(get);
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(50);
    expect((await fetch(get.replace('X-Amz-Signature=', 'X-Amz-Signature=0'))).status).toBe(403);
  });

  it('reports no size for an object that is not there, and deletes one that is', async () => {
    const key = `${prefix}gone`;
    expect(await store.head(key)).toBeNull();
    const { url, headers } = await store.presignPut(key, 5, 'application/octet-stream', 300);
    await put(url, headers, body(5));
    expect(await store.head(key)).toBe(5);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });
});
