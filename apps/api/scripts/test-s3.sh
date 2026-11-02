#!/usr/bin/env bash
# Runs the tests that need a real S3 server (objectStore.live.test.ts, attachmentsIntegration.test.ts in S3 mode)
# against a throwaway SeaweedFS S3 gateway in Docker (scripts/with-s3.sh). Any S3 server works: set S3_LIVE=1 and the
# S3_* variables and run vitest on those two files yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash scripts/with-s3.sh npx vitest run src/__tests__/objectStore.live.test.ts src/__tests__/attachmentsIntegration.test.ts "$@"
