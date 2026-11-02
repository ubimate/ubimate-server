// Creates the test bucket on the throwaway S3 server (scripts/with-s3.sh) and writes and deletes one object, so the
// server has allocated its storage: a fresh one takes seconds over its first write, which would time a test out.
// Reads the S3_* variables. Run from apps/api so the AWS SDK resolves.
import { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION = 'us-east-1' } = process.env;
const client = new S3Client({
  endpoint: S3_ENDPOINT, region: S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});
try {
  await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
} catch (err) {
  if (err?.name !== 'BucketAlreadyOwnedByYou' && err?.name !== 'BucketAlreadyExists') throw err;
}
await client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: 'warm-up', Body: new Uint8Array(16) }));
await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: 'warm-up' }));
