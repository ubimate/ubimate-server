/**
 * The bucket attachments live in when object storage is configured (docs/OBJECT-STORAGE.md,
 * docs/ATTACHMENT-ENCRYPTION.md 6). The API only presigns and measures; deleting is another credential's
 * job (the cleanup job), so a compromised API credential cannot empty the bucket.
 *
 * Detection: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` all set. Without them
 * `getObjectStore()` is null and attachments are kept on the node's disk (local mode), which is a development
 * fallback: with `NODE_ENV=production` the server does not start without a bucket (`assertObjectStorageConfigured`).
 * `S3_CLEANUP_ACCESS_KEY` and `S3_CLEANUP_SECRET_KEY` are the credential that may delete; when they are
 * not set the main one is used, which is why they should be.
 */
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStore {
  /**
   * A URL to PUT `size` bytes of `contentType` to. Both are signed, so a body of any other length or type is
   * refused by the bucket (a bucket that honoured an unsigned length would take any size). Returns the headers
   * the request must carry.
   */
  presignPut(key: string, size: number, contentType: string, expiresInSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** The size of the stored object, or null when there is none. */
  head(key: string): Promise<number | null>;
}

export interface ObjectDeleter {
  delete(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  /** Where browsers reach the bucket, when that is not where the API does (`S3_PUBLIC_ENDPOINT`): the host presigned URLs name. */
  publicEndpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretAccessKey: string;
  cleanupAccessKey: string;
  cleanupSecretAccessKey: string;
  /** True when the cleanup credential is the main one: nothing then keeps the API from deleting. */
  cleanupIsMain: boolean;
}

/** The configuration in `env`, or null when object storage is not configured. */
export function loadS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  const cleanupAccessKey = env.S3_CLEANUP_ACCESS_KEY;
  const cleanupSecretAccessKey = env.S3_CLEANUP_SECRET_KEY;
  const separate = !!cleanupAccessKey && !!cleanupSecretAccessKey;
  return {
    endpoint: S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: env.S3_REGION ?? 'eu-central-1',
    accessKey: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    cleanupAccessKey: separate ? cleanupAccessKey : S3_ACCESS_KEY,
    cleanupSecretAccessKey: separate ? cleanupSecretAccessKey : S3_SECRET_KEY,
    cleanupIsMain: !separate,
  };
}

const REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;

/**
 * Throws, naming the missing variables, when this is a production run (`NODE_ENV=production`) without a complete bucket
 * configuration. Attachments belong in object storage; the disk is for development, and a deployment that forgot the
 * variables would otherwise keep them there without saying so (docs/OBJECT-STORAGE.md).
 */
export function assertObjectStorageConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production' || loadS3Config(env)) return;
  const missing = REQUIRED.filter((k) => !env[k]);
  throw new Error(
    `Object storage is not configured: set ${missing.join(', ')}. Attachments are kept in an S3-compatible bucket in production; `
    + 'see docs/OBJECT-STORAGE.md (a docker-compose example is in docker-compose.yml).',
  );
}

function client(config: S3Config, accessKeyId: string, secretAccessKey: string, endpoint = config.endpoint): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    // Contabo and most self-hosted stores are addressed by path, not by a bucket subdomain.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // The SDK adds a CRC32 checksum to a presigned PUT by default, which a browser's plain PUT does not send.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createS3ObjectStore(config: S3Config): ObjectStore & ObjectDeleter {
  const main = client(config, config.accessKey, config.secretAccessKey);
  // A signed URL is valid for the host it was signed for, and it is the browser that uses it: sign with the address
  // browsers reach. The API's own calls (HEAD, DELETE) go to `endpoint`, which on a private network may differ.
  const signer = config.publicEndpoint === config.endpoint ? main : client(config, config.accessKey, config.secretAccessKey, config.publicEndpoint);
  const cleanup = config.cleanupIsMain ? main : client(config, config.cleanupAccessKey, config.cleanupSecretAccessKey);
  const Bucket = config.bucket;
  return {
    async presignPut(key, size, contentType, expiresInSeconds) {
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: size }),
        { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-length', 'content-type']) },
      );
      return { url, headers: { 'Content-Type': contentType, 'Content-Length': String(size) } };
    },
    presignGet(key, expiresInSeconds) {
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
    async head(key) {
      try {
        const out = await main.send(new HeadObjectCommand({ Bucket, Key: key }));
        return out.ContentLength ?? null;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async delete(key) {
      await cleanup.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

let current: { store: (ObjectStore & Partial<ObjectDeleter>) | null; resolved: boolean } = { store: null, resolved: false };

/** The configured store, or null for local mode. Read from the environment once. */
export function getObjectStore(): (ObjectStore & Partial<ObjectDeleter>) | null {
  if (!current.resolved) {
    const config = loadS3Config();
    if (config?.cleanupIsMain) {
      console.warn('[attachments] S3_CLEANUP_ACCESS_KEY/S3_CLEANUP_SECRET_KEY are not set: the API credential can delete objects');
    }
    current = { store: config ? createS3ObjectStore(config) : null, resolved: true };
  }
  return current.store;
}

/** Replace the store (a fake, or null for local mode). For tests. */
export function setObjectStoreForTests(store: (ObjectStore & Partial<ObjectDeleter>) | null): void {
  current = { store, resolved: true };
}

/** Forget the store, so the next call reads the environment again. For tests. */
export function resetObjectStoreForTests(): void {
  current = { store: null, resolved: false };
}
