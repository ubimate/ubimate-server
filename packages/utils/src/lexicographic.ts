// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Lexicographic ordering utilities for stable, distributed-friendly ordering.
 */

import mudder from 'mudder';

export function generateKeyBetween(before: string | null, after: string | null): string {
  return mudder.base36.mudder(before ?? undefined, after ?? undefined).toString();
}
