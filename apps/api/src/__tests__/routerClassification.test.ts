// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every router that authenticates is either the service (and refuses without a subscription) or is
 * listed here as part of the account. A new router must be put in one or the other. Billing's own
 * router lives in billing/ (docs/CREEM.md §4.9) and is the account by definition. In the self-host
 * extract `requireEntitlement` lets everything through, but the routers are the same files.
 */
describe('every authenticated router is classified', () => {
  const ACCOUNT_ROUTERS = new Set(['usage.ts']);

  it('a router behind requireAuth also uses requireEntitlement, unless it is an account router', () => {
    const dir = path.join(__dirname, '../routes');
    const routers = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    const gated = routers.filter((f) => /Router\.use\(requireAuth\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(gated.length).toBeGreaterThanOrEqual(5);
    for (const file of gated) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const entitled = /Router\.use\(requireEntitlement\)/.test(source);
      expect({ file, classified: entitled !== ACCOUNT_ROUTERS.has(file) }).toEqual({ file, classified: true });
    }
  });
});
