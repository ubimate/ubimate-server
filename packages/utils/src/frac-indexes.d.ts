// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

declare module 'frac-indexes' {
  /** Generate a single fractional index between two existing indexes. */
  export function generateFractionalIndex(
    prevIndex: string | null,
    nextIndex: string | null,
  ): string;

  /** Generate multiple fractional indexes between two existing indexes. */
  export function generateBulkIndexes(
    prevIndex: string | null,
    nextIndex: string | null,
    count: number,
  ): string[];

  /** Generate indexes for relocating multiple items to a new position. */
  export function generateRelocationIndexes(
    targetPrevIndex: string | null,
    targetNextIndex: string | null,
    count: number,
    distributeEvenly?: boolean,
  ): string[];
}
