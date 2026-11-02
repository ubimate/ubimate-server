#!/usr/bin/env bash
# Runs a command with the S3_* variables pointing at a throwaway S3 server (SeaweedFS' S3 gateway in Docker, bound to
# localhost, removed afterwards), with a bucket made. Usage: with-s3.sh <command> [args…]
#
# The server is addressed as `localhost`, not 127.0.0.1: the desktop and mobile apps' content security policy lets
# a webview connect to `http://localhost:*` and `https:` only, and a signed URL is valid for the host it was signed for.
# SeaweedFS ignores an Authorization header beside a query signature, where AWS and Contabo refuse it, so
# S3_IGNORES_AUTH_WITH_SIGNATURE=1 skips that one case of objectStore.live.test.ts.
set -euo pipefail

NAME=ubimate-s3-test
PORT=${S3_TEST_PORT:-8333}
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

cat > "$TMP/s3.json" <<JSON
{"identities":[{"name":"test","credentials":[{"accessKey":"testkey","secretKey":"testsecret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8333" -v "$TMP/s3.json:/etc/s3.json:ro" --tmpfs /data \
  chrislusf/seaweedfs:4.50 server -s3 -s3.config=/etc/s3.json -dir=/data -volume.max=4 >/dev/null

# Ready when the gateway answers an unsigned request with 403 (authentication is on).
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = "403" ] && break
  sleep 1
done

export S3_LIVE=1 S3_ENDPOINT="http://localhost:$PORT" S3_BUCKET=ubimate-test S3_ACCESS_KEY=testkey S3_SECRET_KEY=testsecret
export S3_REGION=us-east-1 S3_IGNORES_AUTH_WITH_SIGNATURE=1
(cd "$HERE/.." && node scripts/prepare-test-bucket.mjs)

"$@"
