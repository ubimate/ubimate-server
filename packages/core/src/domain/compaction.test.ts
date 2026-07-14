import { describe, it, expect } from 'vitest';
import { shouldCompact } from './compaction';
import { COMPACT_THRESHOLD, MIGRATIONS } from '../storage/schema';

describe('shouldCompact', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(shouldCompact(COMPACT_THRESHOLD - 1)).toBe(false);
    expect(shouldCompact(COMPACT_THRESHOLD)).toBe(true);
    expect(shouldCompact(COMPACT_THRESHOLD + 1)).toBe(true);
  });
});

describe('MIGRATIONS', () => {
  it('are strictly increasing and start at 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1);
    }
  });

  it('each migration has at least one statement', () => {
    for (const m of MIGRATIONS) {
      expect(m.statements.length).toBeGreaterThan(0);
    }
  });
});
