/**
 * The rules the in-process S3 server adds to what objectStore.live.test.ts checks through the store: a credential that
 * may not delete, expiry, a wrong secret, CORS. They are what the e2e suites rely on it for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3ObjectStore, type S3Config } from '../lib/objectStore';
import { startS3TestServer, type S3TestServer } from './helpers/s3TestServer';

describe('the in-process S3 server', () => {
  let server: S3TestServer;
  let clock = Date.now();
  let config: S3Config;
  let store: ReturnType<typeof createS3ObjectStore>;

  beforeAll(async () => {
    server = await startS3TestServer({
      bucket: 'b', credentials: { main: 'main-secret', cleanup: 'cleanup-secret' }, denyDelete: ['main'], now: () => clock,
    });
    config = {
      endpoint: server.endpoint, publicEndpoint: server.endpoint, bucket: 'b', region: 'us-east-1', accessKey: 'main', secretAccessKey: 'main-secret',
      cleanupAccessKey: 'cleanup', cleanupSecretAccessKey: 'cleanup-secret', cleanupIsMain: false,
    };
    store = createS3ObjectStore(config);
  });
  afterAll(async () => { await server.close(); });

  const put = async (key: string, n = 10) => {
    const { url, headers } = await store.presignPut(key, n, 'application/octet-stream', 300);
    const { 'Content-Length': _l, ...rest } = headers;
    return fetch(url, { method: 'PUT', headers: rest, body: new Uint8Array(n) });
  };

  it('keeps what was PUT and serves it with its type and length', async () => {
    expect((await put('a/one', 10)).status).toBe(200);
    const res = await fetch(await store.presignGet('a/one', 300));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it('does not let the API credential delete, and lets the cleanup credential', async () => {
    await put('a/two');
    const main = createS3ObjectStore({ ...config, cleanupIsMain: true });
    await expect(main.delete('a/two')).rejects.toThrow();
    expect(await store.head('a/two')).toBe(10);
    await store.delete('a/two');
    expect(await store.head('a/two')).toBeNull();
  });

  it('refuses a presigned URL once it has expired, and not before', async () => {
    await put('a/three');
    const url = await store.presignGet('a/three', 60);
    expect((await fetch(url)).status).toBe(200);
    clock += 59_000;
    expect((await fetch(url)).status).toBe(200);
    clock += 2_000;
    expect((await fetch(url)).status).toBe(403);
    clock = Date.now();
  });

  it('refuses a request signed with another secret', async () => {
    const wrong = createS3ObjectStore({ ...config, secretAccessKey: 'nope', cleanupIsMain: true });
    const { url, headers } = await wrong.presignPut('a/four', 5, 'application/octet-stream', 300);
    const { 'Content-Length': _l, ...rest } = headers;
    expect((await fetch(url, { method: 'PUT', headers: rest, body: new Uint8Array(5) })).status).toBe(403);
    expect(server.objects.has('a/four')).toBe(false);
  });

  it('refuses a key that is not another object\'s: a URL signed for one key does not write another', async () => {
    const { url, headers } = await store.presignPut('a/five', 5, 'application/octet-stream', 300);
    const { 'Content-Length': _l, ...rest } = headers;
    const moved = url.replace('/a/five', '/a/six');
    expect((await fetch(moved, { method: 'PUT', headers: rest, body: new Uint8Array(5) })).status).toBe(403);
  });

  it('answers a preflight and allows any origin, as Contabo does', async () => {
    const res = await fetch(`${server.endpoint}/b/a/x`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:1420', 'Access-Control-Request-Method': 'PUT' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
