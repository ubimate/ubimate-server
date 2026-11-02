import { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from '../../lib/objectStore';

/**
 * Create the bucket the live tests use when `S3_CREATE_BUCKET=1` (a throwaway S3 server started for the run,
 * scripts/test-s3.sh), and write and delete one object so the server has allocated its storage: a fresh one
 * takes seconds over its first write, which would time a test out. Never done against a bucket someone else
 * made: without the variable nothing is created. Call it from a `beforeAll` with a timeout of a minute.
 */
export async function ensureTestBucket(config: S3Config): Promise<void> {
  if (process.env.S3_CREATE_BUCKET !== '1') return;
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    // A plain body, not the aws-chunked trailer encoding the SDK defaults to, which the in-process test server does not speak.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretAccessKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
  await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: 'warm-up', Body: new Uint8Array(16) }));
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: 'warm-up' }));
}
