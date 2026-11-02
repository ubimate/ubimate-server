/**
 * Runs the in-process S3 stand-in (src/__tests__/helpers/s3TestServer.ts) as its own process, for the e2e suites: prints
 * one JSON line, `{"endpoint":…,"bucket":…,…}`, once it listens, and runs until it is killed. The API credential
 * (testkey) may not delete; the cleanup credential (cleankey) may, as in production.
 *   tsx scripts/s3-test-server.ts [port]
 */
// The API package is CommonJS, this folder is not: take the named export from whichever shape the loader gives.
const mod = await import('../src/__tests__/helpers/s3TestServer.ts') as typeof import('../src/__tests__/helpers/s3TestServer') & { default?: typeof import('../src/__tests__/helpers/s3TestServer') };
const { startS3TestServer } = mod.startS3TestServer ? mod : mod.default!;

const server = await startS3TestServer({
  bucket: 'ubimate-test',
  region: 'us-east-1',
  credentials: { testkey: 'testsecret', cleankey: 'cleansecret' },
  denyDelete: ['testkey'],
  port: Number(process.argv[2]) || 0,
});
console.log(JSON.stringify({
  endpoint: server.endpoint, bucket: 'ubimate-test', region: 'us-east-1',
  accessKey: 'testkey', secretAccessKey: 'testsecret', cleanupAccessKey: 'cleankey', cleanupSecretAccessKey: 'cleansecret',
}));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void server.close().then(() => process.exit(0)); });
