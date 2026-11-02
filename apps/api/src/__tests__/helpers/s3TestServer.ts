import { createHash, createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * A small S3-compatible server for tests: one bucket, path-style addressing, objects in memory. It stands in for
 * Contabo so the suites need no Docker and no network, and it is strict where the real stores are (docs/OBJECT-STORAGE.md):
 *
 *  - Every request's AWS Signature V4 is verified, whether it is signed by header (the SDK's HEAD, DELETE, bucket
 *    calls) or by query (a presigned URL). A signed `content-length` or `content-type` that the request does not match
 *    fails the signature, which is how a body of another length is refused (403, as Contabo and SeaweedFS do).
 *  - A request with both an `Authorization` header and a query signature is refused (AWS and Contabo do; SeaweedFS does not).
 *  - A presigned URL is refused after it expires.
 *  - A key listed in `denyDelete` cannot delete: the API's credential must not be able to empty the bucket.
 *  - CORS is answered with `*`, as Contabo does regardless of the bucket's rules.
 *
 * What it does not do: listings, multipart uploads, `aws-chunked` bodies (clients here send `requestChecksumCalculation:
 * 'WHEN_REQUIRED'`), virtual-hosted addressing. It is checked against the real SDK by objectStore.live.test.ts, which
 * also runs against SeaweedFS (`pnpm --filter api test:s3`): the two agreeing is what keeps this one honest.
 */

export interface S3TestServerOptions {
  bucket: string;
  region?: string;
  /** Access key → secret. */
  credentials: Record<string, string>;
  /** Access keys that may not delete objects. */
  denyDelete?: string[];
  port?: number;
  host?: string;
  /** For tests of expiry: the current time in ms. */
  now?: () => number;
}

export interface S3TestServer {
  /** `http://localhost:<port>`: `localhost`, because the desktop and mobile apps' CSP allows that and not 127.0.0.1. */
  endpoint: string;
  /** The stored objects, key → bytes and the type they were PUT with. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Every request answered, newest last. */
  log: { method: string; key: string; status: number; code?: string }[];
  close(): Promise<void>;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function canonicalQuery(rawQuery: string, skip: string[]): string {
  if (!rawQuery) return '';
  return rawQuery.split('&').filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      const v = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1).replace(/\+/g, ' '));
      return [encode(k), encode(v)] as const;
    })
    .filter(([k]) => !skip.includes(k))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
}

function xml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

export async function startS3TestServer(opts: S3TestServerOptions): Promise<S3TestServer> {
  const region = opts.region ?? 'us-east-1';
  const now = opts.now ?? Date.now;
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const log: S3TestServer['log'] = [];
  const denyDelete = new Set(opts.denyDelete ?? []);

  function verify(req: http.IncomingMessage, rawPath: string, rawQuery: string): { ok: true; accessKey: string } | { ok: false; code: string; status: number } {
    const query = new URLSearchParams(rawQuery);
    const authorization = req.headers.authorization;
    const presigned = query.has('X-Amz-Signature');
    if (presigned && authorization) return { ok: false, code: 'InvalidArgument', status: 400 };

    let credential: string, signedHeaders: string, signature: string, amzDate: string, payloadHash: string;
    if (presigned) {
      if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return { ok: false, code: 'InvalidArgument', status: 400 };
      credential = query.get('X-Amz-Credential') ?? '';
      signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
      signature = query.get('X-Amz-Signature') ?? '';
      amzDate = query.get('X-Amz-Date') ?? '';
      payloadHash = 'UNSIGNED-PAYLOAD';
      const seconds = Number(query.get('X-Amz-Expires'));
      const issued = Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      if (!Number.isFinite(issued) || !Number.isFinite(seconds)) return { ok: false, code: 'AuthorizationQueryParametersError', status: 400 };
      if (now() > issued + seconds * 1000) return { ok: false, code: 'AccessDenied', status: 403 };
    } else {
      const m = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]+)$/.exec(authorization ?? '');
      if (!m) return { ok: false, code: 'AccessDenied', status: 403 };
      [, credential, signedHeaders, signature] = m;
      amzDate = String(req.headers['x-amz-date'] ?? '');
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    }

    const [accessKey, date, credRegion, service, term] = credential.split('/');
    const secret = opts.credentials[accessKey];
    if (!secret) return { ok: false, code: 'InvalidAccessKeyId', status: 403 };
    if (credRegion !== region || service !== 's3' || term !== 'aws4_request' || !amzDate.startsWith(date)) {
      return { ok: false, code: 'AuthorizationHeaderMalformed', status: 400 };
    }

    const names = signedHeaders.split(';');
    const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonicalRequest = [
      req.method, rawPath, canonicalQuery(rawQuery, ['X-Amz-Signature']), canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
    const expected = createHmac('sha256', key).update(toSign).digest('hex');
    if (expected !== signature) return { ok: false, code: 'SignatureDoesNotMatch', status: 403 };
    return { ok: true, accessKey };
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const rawPath = q < 0 ? url : url.slice(0, q);
      const rawQuery = q < 0 ? '' : url.slice(q + 1);
      const method = req.method ?? 'GET';
      const segments = rawPath.split('/').filter(Boolean).map(decodeURIComponent);
      const bucket = segments[0];
      const key = segments.slice(1).join('/');

      const send = (status: number, body: string | Buffer = '', headers: Record<string, string | number> = {}, code?: string) => {
        log.push({ method, key, status, code });
        res.writeHead(status, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'ETag, Content-Length',
          ...(body && !headers['Content-Type'] ? { 'Content-Type': 'application/xml' } : {}),
          ...headers,
        });
        res.end(method === 'HEAD' || !body.length ? undefined : body);
      };
      const fail = (status: number, code: string) => send(status, xml(code, code), {}, code);

      if (method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, HEAD, DELETE',
          'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] ?? '*'),
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      const verdict = verify(req, rawPath, rawQuery);
      if (!verdict.ok) return fail(verdict.status, verdict.code);
      if (bucket !== opts.bucket) return fail(404, 'NoSuchBucket');

      if (!key) {
        // Creating the bucket that already exists, as `ensureTestBucket` does.
        if (method === 'PUT') return send(409, xml('BucketAlreadyOwnedByYou', 'exists'), {}, 'BucketAlreadyOwnedByYou');
        return fail(501, 'NotImplemented');
      }

      switch (method) {
        case 'PUT': {
          const body = Buffer.concat(chunks);
          const type = String(req.headers['content-type'] ?? 'binary/octet-stream');
          objects.set(key, { body, contentType: type });
          return send(200, '', { ETag: `"${createHash('md5').update(body).digest('hex')}"` });
        }
        case 'GET':
        case 'HEAD': {
          const o = objects.get(key);
          if (!o) return fail(404, 'NoSuchKey');
          return send(200, method === 'GET' ? o.body : '', { 'Content-Length': o.body.length, 'Content-Type': o.contentType });
        }
        case 'DELETE': {
          if (denyDelete.has(verdict.accessKey)) return fail(403, 'AccessDenied');
          objects.delete(key);
          return send(204);
        }
        default:
          return fail(405, 'MethodNotAllowed');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://localhost:${port}`,
    objects,
    log,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
