/**
 * Lexicographic ordering utilities for stable, distributed-friendly ordering.
 * Backed by the `frac-indexes` package.
 */

import { generateFractionalIndex, generateBulkIndexes } from 'frac-indexes';

/**
 * Generate a fractional-index string between two positions.
 * @param before Position immediately before the desired slot (or null for beginning)
 * @param after  Position immediately after the desired slot (or null for end)
 * @returns A new position string that sorts between before and after
 */
export function generateKeyBetween(before: string | null, after: string | null): string {
  return generateFractionalIndex(before, after);
}

/**
 * Generate N evenly distributed keys between two positions.
 * @param count Number of keys to generate
 * @param before Lower bound (or null)
 * @param after  Upper bound (or null)
 * @returns Array of position strings
 */
export function generateNKeys(count: number, before: string | null = null, after: string | null = null): string[] {
  if (count === 0) return [];
  if (count === 1) return [generateFractionalIndex(before, after)];
  return generateBulkIndexes(before, after, count);
}


