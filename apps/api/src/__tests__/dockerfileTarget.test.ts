/**
 * scripts/dockerfile-target.mjs, which the CapRover deploys (`caprover:deploy-api`,
 * `caprover:deploy-app`) upload as the Dockerfile. CapRover's classic builder runs every stage above
 * the target, and a deploy uploads only its own app's files, so a stage for another app fails the
 * build on a missing file: the cut-down Dockerfile must keep exactly the target and what it builds
 * from.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/dockerfile-target.mjs');

const cut = (target: string, file?: string) =>
  execFileSync('node', [SCRIPT, target, ...(file ? [file] : [])], { encoding: 'utf8' });

/** Stage names a Dockerfile defines, and the stages each FROM / COPY --from refers to. */
function stagesOf(dockerfile: string) {
  const defined = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase());
  const referenced = [
    ...[...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1].toLowerCase()),
    ...[...dockerfile.matchAll(/--from=(\S+)/g)].map((m) => m[1].toLowerCase()),
  ];
  return { defined, referenced };
}

describe('dockerfile-target.mjs on the repo Dockerfile', () => {
  const all = stagesOf(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')).defined;

  for (const target of ['unified', 'api']) {
    it(`keeps "${target}" and only the stages it builds from`, () => {
      const out = cut(target);
      const { defined, referenced } = stagesOf(out);
      expect(defined.at(-1)).toBe(target);
      // Every stage the output refers to is in it…
      for (const ref of referenced) if (all.includes(ref)) expect(defined).toContain(ref);
      // …and nothing else: every kept stage is the target or something referred to.
      for (const stage of defined) expect(stage === target || referenced.includes(stage)).toBe(true);
      // Not vacuous: the repo Dockerfile has stages for other apps, and they are gone.
      expect(defined.length).toBeLessThan(all.length);
    });
  }

  it('drops the other apps\' stages from the unified build', () => {
    const { defined } = stagesOf(cut('unified'));
    expect(defined).toEqual(['unified-builder', 'unified']);
  });

  it('fails on a target the Dockerfile does not have', () => {
    expect(() => execFileSync('node', [SCRIPT, 'nope'], { stdio: 'pipe' })).toThrow(/no stage "nope"/);
  });
});

describe('dockerfile-target.mjs on a small Dockerfile', () => {
  it('follows FROM and COPY --from chains, and keeps each stage\'s banner comment', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dockerfile-target-')), 'Dockerfile');
    fs.writeFileSync(file, [
      'ARG NODE=20',
      '',
      '# --- base ---',
      'FROM node:20 AS base',
      'RUN echo base',
      '',
      '# --- other app ---',
      'FROM base AS other',
      'COPY other/ /other',
      '',
      '# --- builder ---',
      'FROM base AS builder',
      'RUN echo build',
      '',
      '# --- final ---',
      'FROM nginx AS final',
      'COPY --from=builder /out /srv',
      '',
    ].join('\n'));
    const out = cut('final', file);
    expect(stagesOf(out).defined).toEqual(['base', 'builder', 'final']);
    expect(out).toContain('ARG NODE=20');
    expect(out).toContain('# --- builder ---');
    expect(out).not.toContain('other');
  });
});
