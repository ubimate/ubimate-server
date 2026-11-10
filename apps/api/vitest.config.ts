import fs from 'node:fs';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * API tests that need something from the monorepo besides the API: apps/web's client and relay
 * provider, or a root script. The self-host server (ubimate-server, docs/CREEM.md §4.9) ships the
 * tests but not those, so there they are skipped, and said to be, instead of failing to import.
 * Each entry must name a test that exists, so the list cannot go stale.
 */
const NEEDS: { test: string; needs: string }[] = [
  { test: 'src/__tests__/attachmentsIntegration.test.ts', needs: '../web/src/api/client.ts' },
  { test: 'src/__tests__/keyRotationEndToEnd.test.ts', needs: '../web/src/api/client.ts' },
  { test: 'src/__tests__/relayIntegration.test.ts', needs: '../web/src/api/CloudRelayProvider.ts' },
  { test: 'src/__tests__/dockerfileTarget.test.ts', needs: '../../scripts/dockerfile-target.mjs' },
];

const here = import.meta.dirname;
for (const { test } of NEEDS) {
  if (!fs.existsSync(path.join(here, test))) throw new Error(`vitest.config.ts lists ${test}, which does not exist`);
}
const skipped = NEEDS.filter(({ needs }) => !fs.existsSync(path.join(here, needs)));
if (skipped.length > 0) {
  console.log(`[vitest] skipping ${skipped.length} test file(s) that need the full monorepo:\n${skipped.map((s) => `  ${s.test} (needs ${s.needs})`).join('\n')}`);
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...skipped.map((s) => s.test)],
  },
});
