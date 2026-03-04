/**
 * Lexicographic ordering utilities for stable, distributed-friendly ordering.
 */

import mudder from 'mudder';

export function generateKeyBetween(before: string | null, after: string | null): string {
  return mudder.base36.mudder(before ?? undefined, after ?? undefined).toString();
}
