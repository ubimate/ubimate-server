// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * The API imports workspace packages that ship TypeScript source (`main` is a `.ts` file) only with
 * `import type`.
 *
 * In production the API is compiled and run by plain Node (`node apps/api/dist/index.js`), which
 * loads a package's built `dist` but cannot load TypeScript source. `tsx` (dev) and vitest (here) can,
 * so a value import from such a package works everywhere except the server: `RELAY_FRAME` came from
 * `@ubimate/types` from August to October 2026, and every production build in that time crashed on
 * start with `SyntaxError: Unexpected token 'export'`. `import type` is erased by the compiler, so it
 * is safe.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const apiSrc = path.resolve(__dirname, '..');

/** Workspace packages whose entry point is TypeScript source. */
function sourceOnlyPackages(): string[] {
  const dir = path.join(repoRoot, 'packages');
  return fs.readdirSync(dir).flatMap((name) => {
    const manifest = path.join(dir, name, 'package.json');
    if (!fs.existsSync(manifest)) return [];
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      name: string;
      main?: string;
      exports?: Record<string, unknown> | string;
    };
    const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
    const entry = typeof dot === 'string' ? dot : pkg.main;
    return entry?.endsWith('.ts') ? [pkg.name] : [];
  });
}

/** The API's shipped sources: what `tsc` compiles into `dist` (tests are excluded from it). */
function shippedSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : shippedSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** Every `import`/`export … from`, `require()` and `import()` of a module, with whether it is type-only. */
function moduleReferences(code: string): { specifier: string; typeOnly: boolean; text: string }[] {
  const refs: { specifier: string; typeOnly: boolean; text: string }[] = [];
  const staticRe = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(staticRe)) refs.push({ specifier: m[3], typeOnly: !!m[2], text: m[0] });
  const callRe = /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(callRe)) refs.push({ specifier: m[1], typeOnly: false, text: m[0] });
  return refs;
}

describe('the API imports source-only workspace packages for types only', () => {
  it('knows which packages ship source, and finds the API sources', () => {
    // Count before looping: an empty list would make the next test pass without checking anything.
    expect(sourceOnlyPackages()).toContain('@ubimate/types');
    expect(sourceOnlyPackages()).not.toContain('@ubimate/utils');
    expect(shippedSources(apiSrc).map((f) => path.basename(f))).toContain('relay.ts');
  });

  it('has no value import from one', () => {
    const sourceOnly = new Set(sourceOnlyPackages());
    const offending = shippedSources(apiSrc).flatMap((file) =>
      moduleReferences(fs.readFileSync(file, 'utf8'))
        .filter((ref) => !ref.typeOnly && sourceOnly.has(ref.specifier.split('/').slice(0, 2).join('/')))
        .map((ref) => `${path.relative(apiSrc, file)}: ${ref.text.replace(/\s+/g, ' ')}`),
    );
    expect(offending).toEqual([]);
  });

  it('recognises a value import as one', () => {
    // The check above passes on an empty match as well as a clean tree; prove the parser sees both kinds.
    const refs = moduleReferences(
      "import { RELAY_FRAME } from '@ubimate/types';\nimport type {\n  A,\n  B,\n} from '@ubimate/types';",
    );
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ['@ubimate/types', false],
      ['@ubimate/types', true],
    ]);
  });
});
